/**
 * Twilio Media Streams — WebSocket Gateway
 *
 * Handles the real-time audio bridge between Twilio and the voice agent.
 * Twilio sends audio as base64-encoded μ-law (mulaw) at 8kHz via WebSocket.
 * We convert and route to either:
 *   - Modular pipeline: Deepgram STT → Orchestrator → LLM → Cartesia TTS → Twilio
 *   - Grok S2S pipeline: Audio → Grok Voice API → Audio → Twilio
 *
 * Twilio Media Streams protocol:
 *   https://www.twilio.com/docs/voice/media-streams
 *
 * Events from Twilio:
 *   - 'connected'  — WebSocket established
 *   - 'start'      — Stream metadata (callSid, tracks, mediaFormat)
 *   - 'media'      — Audio chunk (base64 mulaw 8kHz)
 *   - 'stop'       — Stream ended
 *   - 'mark'       — Playback marker reached
 *
 * Events to Twilio:
 *   - 'media'      — Send audio back (base64 mulaw 8kHz)
 *   - 'mark'       — Set playback marker
 *   - 'clear'      — Clear audio queue (for barge-in/interruption)
 */

import WebSocket from 'ws';
import { v4 as uuid } from 'uuid';
import type { Logger } from 'pino';
import type { CalcModel, AuthTier } from '../types.js';
import { CallPurpose, CallDirection, CallType } from '../types.js';
import type { VoicePipelineController } from './pipeline-controller.js';
import type { DeepgramSTTClient } from './deepgram-client.js';
import type { CartesiaTTSClient } from './cartesia-client.js';
import type { LLMService } from '../llm/provider.js';
import type { ToolExecutor } from '../llm/tool-executor.js';
import { buildToolSchemas } from '../llm/provider.js';
import type { ConversationMemoryService } from '../services/conversation-memory.js';
import { sanitizeForTTS, formatForSpeech, checkFastPath, JACK_SYSTEM_PROMPT, CINDY_SYSTEM_PROMPT, JENNY_SYSTEM_PROMPT, buildAgentSystemPrompt, buildMemoryAwareSystemPrompt, type CallState } from '../voice/voice-call-directive.js';
import {
  personaRegistry, convStateEngine, turnTakingManager, callOutcomeLogger,
  type VoicePersona, type ConvPhase,
} from '../voice/voice-intelligence.js';

// ============================================================================
// Twilio Message Types
// ============================================================================

interface TwilioConnectedMessage {
  event: 'connected';
  protocol: string;
  version: string;
}

interface TwilioStartMessage {
  event: 'start';
  sequenceNumber: string;
  start: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    mediaFormat: {
      encoding: string;   // 'audio/x-mulaw'
      sampleRate: number;  // 8000
      channels: number;    // 1
    };
    customParameters: Record<string, string>;
  };
}

interface TwilioMediaMessage {
  event: 'media';
  sequenceNumber: string;
  media: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string;  // base64 mulaw audio
  };
}

interface TwilioStopMessage {
  event: 'stop';
  sequenceNumber: string;
  stop: {
    accountSid: string;
    callSid: string;
  };
}

interface TwilioMarkMessage {
  event: 'mark';
  sequenceNumber: string;
  mark: { name: string };
}

type TwilioInboundMessage =
  | TwilioConnectedMessage
  | TwilioStartMessage
  | TwilioMediaMessage
  | TwilioStopMessage
  | TwilioMarkMessage;

// ============================================================================
// Audio Conversion Utilities
// ============================================================================

/**
 * μ-law to 16-bit PCM lookup table.
 * Twilio sends mulaw 8kHz; Deepgram and Grok want PCM 16kHz.
 */
const MULAW_TO_PCM = new Int16Array(256);
(function buildMulawTable() {
  for (let i = 0; i < 256; i++) {
    let mu = ~i & 0xff;
    const sign = mu & 0x80;
    mu &= 0x7f;
    mu = (mu << 1) | 1;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    MULAW_TO_PCM[i] = sign ? -sample : sample;
  }
})();

function mulawToPCM16(mulawBuffer: Buffer): Buffer {
  const pcm = Buffer.alloc(mulawBuffer.length * 2);
  for (let i = 0; i < mulawBuffer.length; i++) {
    const sample = MULAW_TO_PCM[mulawBuffer[i]];
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

/**
 * PCM 16-bit to μ-law encoding.
 * For sending audio back to Twilio.
 */
function pcm16ToMulaw(pcmBuffer: Buffer): Buffer {
  const mulaw = Buffer.alloc(pcmBuffer.length / 2);
  for (let i = 0; i < mulaw.length; i++) {
    let sample = pcmBuffer.readInt16LE(i * 2);
    const sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    if (sample > 32635) sample = 32635;
    sample += 0x84;

    let exponent = 7;
    const expMask = 0x4000;
    for (; exponent > 0; exponent--) {
      if (sample & expMask) break;
      sample <<= 1;
    }

    const mantissa = (sample >> 10) & 0x0f;
    mulaw[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return mulaw;
}

/**
 * Simple 8kHz → 16kHz upsampling via linear interpolation.
 * Deepgram Nova-3 expects 16kHz.
 */
function upsample8to16(pcm8k: Buffer): Buffer {
  const samples8k = pcm8k.length / 2;
  const pcm16k = Buffer.alloc(samples8k * 4); // 2x samples, 2 bytes each

  for (let i = 0; i < samples8k - 1; i++) {
    const s1 = pcm8k.readInt16LE(i * 2);
    const s2 = pcm8k.readInt16LE((i + 1) * 2);
    const mid = Math.round((s1 + s2) / 2);
    pcm16k.writeInt16LE(s1, i * 4);
    pcm16k.writeInt16LE(mid, i * 4 + 2);
  }

  // Last sample — duplicate
  const last = pcm8k.readInt16LE((samples8k - 1) * 2);
  pcm16k.writeInt16LE(last, (samples8k - 1) * 4);
  pcm16k.writeInt16LE(last, (samples8k - 1) * 4 + 2);

  return pcm16k;
}

/**
 * 16kHz → 8kHz downsampling (take every other sample).
 * For sending TTS audio back to Twilio.
 */
function downsample16to8(pcm16k: Buffer): Buffer {
  const samples16k = pcm16k.length / 2;
  const pcm8k = Buffer.alloc(Math.floor(samples16k / 2) * 2);

  for (let i = 0; i < pcm8k.length / 2; i++) {
    const sample = pcm16k.readInt16LE(i * 4);
    pcm8k.writeInt16LE(sample, i * 2);
  }

  return pcm8k;
}

/**
 * 24kHz → 8kHz downsampling with anti-aliasing FIR low-pass filter.
 * Cartesia Sonic-3 outputs 24kHz; Twilio needs 8kHz mulaw.
 *
 * Uses a 15-tap windowed-sinc FIR filter (Hamming window, cutoff ~3.5kHz)
 * to prevent aliasing artifacts before 3:1 decimation.
 */
const LP_FILTER_TAPS = (() => {
  // 15-tap low-pass FIR, cutoff at 4kHz/24kHz = 0.167 normalized
  // Generated with windowed sinc (Hamming window)
  const N = 15;
  const fc = 1 / 3; // cutoff = 8kHz / 24kHz
  const taps = new Float64Array(N);
  const mid = (N - 1) / 2;
  let sum = 0;
  for (let n = 0; n < N; n++) {
    const x = n - mid;
    // Sinc function
    const sinc = x === 0 ? 1.0 : Math.sin(Math.PI * fc * 2 * x) / (Math.PI * x);
    // Hamming window
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (N - 1));
    taps[n] = sinc * window;
    sum += taps[n];
  }
  // Normalize to unity gain
  for (let n = 0; n < N; n++) taps[n] /= sum;
  return taps;
})();

function downsample24to8(pcm24k: Buffer): Buffer {
  const samples24k = pcm24k.length / 2;
  const outSamples = Math.floor(samples24k / 3);
  const pcm8k = Buffer.alloc(outSamples * 2);
  const halfTaps = Math.floor(LP_FILTER_TAPS.length / 2);

  for (let i = 0; i < outSamples; i++) {
    const center = i * 3;
    let acc = 0;
    for (let t = 0; t < LP_FILTER_TAPS.length; t++) {
      const idx = center - halfTaps + t;
      if (idx >= 0 && idx < samples24k) {
        acc += pcm24k.readInt16LE(idx * 2) * LP_FILTER_TAPS[t];
      }
    }
    const clamped = Math.max(-32768, Math.min(32767, Math.round(acc)));
    pcm8k.writeInt16LE(clamped, i * 2);
  }

  return pcm8k;
}

// ============================================================================
// Session Config
// ============================================================================

export interface TwilioSessionConfig {
  /** Which Calculus model this number maps to */
  model: CalcModel;

  /** Call direction */
  direction: 'inbound' | 'outbound';

  /** Caller phone number */
  callerPhone: string;

  /** Called phone number */
  calledPhone: string;

  /** Initial auth tier (0 for anonymous inbound) */
  initialAuthTier: AuthTier;
}

// ============================================================================
// Phone Number → Model Routing
// ============================================================================

const PHONE_MODEL_MAP: Record<string, CalcModel> = {
  // Production: load from env vars; fallback to placeholders for dev
  [process.env.PHONE_DMC || '+18001234567']: 'DMC' as CalcModel,
  [process.env.PHONE_CT || '+18002345678']: 'CONSTITUTIONAL_TENDER' as CalcModel,
  [process.env.PHONE_TILT || '+18003456789']: 'TILT' as CalcModel,
  [process.env.PHONE_MORTGAGE || '+18004567890']: 'MORTGAGE' as CalcModel,
  [process.env.PHONE_REAL_ESTATE || '+18005678901']: 'REAL_ESTATE' as CalcModel,
  [process.env.PHONE_EUREKA || '+18006789012']: 'EUREKA' as CalcModel,
  [process.env.PHONE_LOAN_SERVICING || '+18007890123']: 'LOAN_SERVICING' as CalcModel,
  [process.env.PHONE_IFSE || '+18008901234']: 'IFSE' as CalcModel,
  [process.env.PHONE_JACK || '+12243850755']: 'JACK' as CalcModel,
  [process.env.PHONE_JENNY || '+14014256830']: 'JENNY' as CalcModel,
  [process.env.PHONE_BUNNY || '+18338472291']: 'BUNNY' as CalcModel,
  [process.env.PHONE_CINDY || '']: 'CINDY' as CalcModel,
};

export function resolveModelFromNumber(phone: string): CalcModel {
  return PHONE_MODEL_MAP[phone] ?? ('DMC' as CalcModel);
}

// ============================================================================
// Twilio WebSocket Handler
// ============================================================================

export class TwilioMediaStreamHandler {
  private ws: WebSocket;
  private pipelineController: VoicePipelineController;
  private deepgram: DeepgramSTTClient;
  private cartesia: CartesiaTTSClient;
  private llm: LLMService;
  private toolExecutor: ToolExecutor;
  private conversationMemory: ConversationMemoryService;
  private logger: Logger;

  private streamSid: string | null = null;
  private callSid: string | null = null;
  private sessionConfig: TwilioSessionConfig | null = null;
  private isStreaming = false;
  private markCounter = 0;

  // Audio buffering for barge-in detection
  private isSpeaking = false;  // Is the agent currently speaking?
  private twilioAudioChunksSent = 0;
  private pendingMarks: Set<string> = new Set();
  private audioChunksSent = 0;
  private audioContentLogged = false;

  // Multi-language support
  private detectedLanguage: string = 'en';

  // Conversation tracking for memory persistence
  private callStartTime: Date | null = null;
  private topicsDiscussed: string[] = [];
  private callOutcome: string = 'completed';

  // Outbound call context (set from TwiML custom parameters)
  private outboundMessage: string | null = null;
  private outboundRecipientName: string | null = null;

  // Sentiment tracking
  private sentimentScore: number = 0;
  private consecutiveNegative: number = 0;

  // Call state machine (VOICE-CALL-01)
  private callState: CallState = 'idle';

  // Voice Intelligence (persona, conv state, turn tracking)
  private persona: VoicePersona | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private static readonly SILENCE_TIMEOUT_MS = 6000;

  constructor(params: {
    ws: WebSocket;
    pipelineController: VoicePipelineController;
    deepgram: DeepgramSTTClient;
    cartesia: CartesiaTTSClient;
    llm: LLMService;
    toolExecutor: ToolExecutor;
    conversationMemory: ConversationMemoryService;
    logger: Logger;
  }) {
    this.ws = params.ws;
    this.pipelineController = params.pipelineController;
    this.deepgram = params.deepgram;
    this.cartesia = params.cartesia;
    this.llm = params.llm;
    this.toolExecutor = params.toolExecutor;
    this.conversationMemory = params.conversationMemory;
    this.logger = params.logger.child({ component: 'TwilioMediaStream' });

    this.setupWebSocketHandlers();
    this.setupDeepgramHandlers();
    this.setupCartesiaHandlers();
  }

  // ==========================================================================
  // WebSocket Event Handlers
  // ==========================================================================

  private setupWebSocketHandlers(): void {
    this.ws.on('message', (data: Buffer | string) => {
      try {
        const msg: TwilioInboundMessage = JSON.parse(
          typeof data === 'string' ? data : data.toString(),
        );
        this.handleTwilioMessage(msg);
      } catch (error) {
        this.logger.error({ error }, 'Failed to parse Twilio message');
      }
    });

    this.ws.on('close', (code, reason) => {
      this.logger.info({ code, reason: reason.toString() }, 'Twilio WebSocket closed');
      this.cleanup();
    });

    this.ws.on('error', (error) => {
      this.logger.error({ error }, 'Twilio WebSocket error');
    });
  }

  private handleTwilioMessage(msg: TwilioInboundMessage): void {
    switch (msg.event) {
      case 'connected':
        this.logger.info('Twilio Media Stream connected');
        break;

      case 'start':
        this.handleStreamStart(msg);
        break;

      case 'media':
        this.handleMediaChunk(msg);
        break;

      case 'stop':
        this.handleStreamStop();
        break;

      case 'mark':
        this.handleMark(msg);
        break;
    }
  }

  // ==========================================================================
  // Stream Lifecycle
  // ==========================================================================

  private async handleStreamStart(msg: TwilioStartMessage): Promise<void> {
    this.streamSid = msg.start.streamSid;
    this.callSid = msg.start.callSid;
    this.isStreaming = true;

    const params = msg.start.customParameters;
    // For outbound calls, resolve model from the From number (our number)
    // For inbound calls, resolve from the To number (our number)
    const model = (params.model as CalcModel)
      ?? resolveModelFromNumber(params.calledPhone ?? '')
      ?? resolveModelFromNumber(params.callerPhone ?? '');

    this.sessionConfig = {
      model,
      direction: (params.direction as 'inbound' | 'outbound') ?? 'inbound',
      callerPhone: params.callerPhone ?? '',
      calledPhone: params.calledPhone ?? '',
      initialAuthTier: 0 as AuthTier,
    };

    // Capture outbound call context from custom parameters
    if (params.outboundMessage) {
      this.outboundMessage = params.outboundMessage;
    }
    if (params.recipientName) {
      this.outboundRecipientName = params.recipientName;
    }

    this.logger.info({
      streamSid: this.streamSid,
      callSid: this.callSid,
      model,
      direction: this.sessionConfig.direction,
      tracks: msg.start.tracks,
      mediaFormat: msg.start.mediaFormat,
    }, 'Stream started');

    // Initialize the pipeline controller for this call
    const result = await this.pipelineController.initializeCall({
      callDirection: this.sessionConfig.direction === 'inbound' ? CallDirection.INBOUND : CallDirection.OUTBOUND,
      callType: this.sessionConfig.direction === 'inbound' ? CallType.SERVICE : CallType.CALLBACK,
      callPurpose: CallPurpose.INFORMATIONAL,
      model: this.sessionConfig.model,
      recipientPhone: this.sessionConfig.callerPhone,
      recipientState: 'CT', // Would resolve from phone number in production
      callerIdNumber: this.sessionConfig.calledPhone,
      callerIdName: this.sessionConfig.model,
      customerId: null,
      initialAuthTier: 0 as AuthTier,
    });

    if (!result.proceed) {
      this.logger.warn({ reason: result.blockReason }, 'Call blocked by pre-dial gates');
      this.ws.close(1000, 'blocked');
      return;
    }

    // Track call start time for memory persistence
    this.callStartTime = new Date();
    this.callState = 'listening';

    // Load persona and initialize conversational state
    this.persona = personaRegistry.getByAgent(model as string) ?? personaRegistry.getByAgent('JACK');
    const convId = this.callSid ?? 'unknown';
    convStateEngine.initialize(convId, model as string);
    turnTakingManager.logEvent(convId, 'agent_start', 0, 'call started');

    // Set the TTS voice for this model
    this.cartesia.setModel(model);

    // Load caller memory for personalized greeting
    const callerPhone = this.sessionConfig.callerPhone;
    let callerMemory: any = null;
    if (callerPhone) {
      try {
        callerMemory = await this.conversationMemory.getCallerContext(callerPhone);
        if (callerMemory) {
          this.logger.info({ phone: callerPhone, callCount: callerMemory.callCount, name: callerMemory.name }, 'Returning caller recognized');
        }
      } catch (err: any) {
        this.logger.warn({ error: err?.message }, 'Failed to load caller memory — continuing without');
      }
    }

    // Start Deepgram + Cartesia in parallel to reduce call answer latency
    await Promise.all([
      this.deepgram.startStream({
        encoding: 'linear16',
        sampleRate: 16000,
        channels: 1,
        model: 'nova-2',
        language: 'en',
        detectLanguage: false,
        smartFormat: true,
        punctuate: false,
        interimResults: true,
        endpointing: 600,
        utteranceEndMs: 700,
        vadEvents: true,
      }),
      this.cartesia.connect(),
    ]);

    // Deliver greeting — outbound with context, personalized for returning, or standard disclosure
    const firstTurn = await this.pipelineController.processTurn('');
    if (firstTurn.type === 'system_action' && firstTurn.action === 'deliver_disclosure') {
      if (this.outboundMessage && this.sessionConfig.direction === 'outbound') {
        // Outbound call with specific instructions — use LLM to generate opening
        this.logger.info({ outboundMessage: this.outboundMessage, recipient: this.outboundRecipientName }, 'Outbound call with context — generating opening via LLM');
        try {
          this.isSpeaking = true;
          const agentName = model === 'JENNY' ? 'Jenny' : model === 'BUNNY' ? 'Bunny' : 'Jack';
          await this.generateStreamingLLMResponse({
            type: 'respond',
            provider: 'gpt-4o',
            intent: 'outbound_greeting',
            userUtterance: '',
            responseInstruction: `You are ${agentName} from Calculus Holdings. You are making an outbound call to ${this.outboundRecipientName || 'a client'}. Your instructions: ${this.outboundMessage}. Start speaking immediately — the person has just picked up the phone. Speak naturally, calmly, and conversationally — like a real person, not an AI. Use a relaxed pace with natural pauses. Keep responses concise (1-3 sentences max unless singing or telling a story).`,
            tools: [],
            latencyBudget: 1500,
          }, '');
        } catch (err: any) {
          this.logger.error({ error: err?.message }, 'Failed to generate outbound greeting');
          await this.speakDisclosure();
        }
      } else if (callerMemory && callerMemory.callCount > 0) {
        // Returning caller — use personalized greeting from memory
        const agentName = model === 'JENNY' ? 'Jenny' : model === 'BUNNY' ? 'Bunny' : 'Jack';
        const greeting = await this.conversationMemory.getCallerGreeting(callerPhone, agentName);
        await this.speak(greeting);
      } else {
        await this.speakDisclosure();
      }
    }
  }

  private handleStreamStop(): void {
    this.logger.info({ callSid: this.callSid }, 'Stream stopped');
    this.isStreaming = false;
    this.clearSilenceTimer();
    this.callState = 'idle';
    this.cleanup();
  }

  // ==========================================================================
  // Audio Processing — Inbound (Caller → Agent)
  // ==========================================================================

  private handleMediaChunk(msg: TwilioMediaMessage): void {
    if (!this.isStreaming) return;

    const mulawAudio = Buffer.from(msg.media.payload, 'base64');
    const track = (msg.media as any).track ?? 'unknown';

    // One-time diagnostic: check audio content and track
    if (!this.audioContentLogged && mulawAudio.length > 0) {
      this.audioContentLogged = true;
      // Check if audio is silence (mulaw silence = 0xFF or 0x7F)
      let silenceCount = 0;
      for (let i = 0; i < Math.min(mulawAudio.length, 100); i++) {
        if (mulawAudio[i] === 0xFF || mulawAudio[i] === 0x7F) silenceCount++;
      }
      const firstBytes = Array.from(mulawAudio.subarray(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      this.logger.info({
        track,
        audioLen: mulawAudio.length,
        firstBytes,
        silenceRatio: `${silenceCount}/${Math.min(mulawAudio.length, 100)}`,
        deepgramConnected: this.deepgram.connected,
      }, 'AUDIO DIAGNOSTIC: first media chunk received');
    }

    // Check active pipeline
    const activePipeline = this.pipelineController.getActivePipeline();

    if (activePipeline === 'speech-to-speech') {
      // Route directly to Grok — no STT needed
      // Convert mulaw 8kHz → PCM 16kHz for Grok
      const pcm8k = mulawToPCM16(mulawAudio);
      const pcm16k = upsample8to16(pcm8k);
      this.pipelineController.routeAudio(pcm16k);
      return;
    }

    // NOTE: Barge-in is handled via Deepgram speechStarted event (setupDeepgramHandlers),
    // NOT here — we must NOT clear audio on every media chunk or ambient noise kills the greeting.

    // Convert mulaw 8kHz -> PCM16 8kHz -> PCM16 16kHz for Deepgram linear16 mode
    const pcm8k = mulawToPCM16(mulawAudio);
    const pcm16k = upsample8to16(pcm8k);
    this.deepgram.sendAudio(pcm16k);
    this.audioChunksSent++;
    if (this.audioChunksSent % 100 === 1) {
      this.logger.info({ chunks: this.audioChunksSent, bytes: mulawAudio.length, track, dgConnected: this.deepgram.connected }, 'Audio chunks sent to Deepgram');
    }
  }

  // ==========================================================================
  // Deepgram STT Handlers
  // ==========================================================================

  private setupDeepgramHandlers(): void {
    this.deepgram.on('transcript', async (transcript: string, isFinal: boolean) => {
      this.logger.info({ transcript: transcript.substring(0, 60), isFinal }, 'Deepgram transcript event');
      if (!isFinal) return; // Only process final transcripts
      if (!transcript.trim()) return;

      this.logger.info({ transcript }, 'Caller said');
      this.callState = 'listening';
      this.resetSilenceTimer();

      // Fast-path: repeated name invocation (VOICE-CALL-01 sec 4)
      const fastPathResponse = checkFastPath(transcript);
      if (fastPathResponse) {
        this.logger.info({ transcript, response: fastPathResponse }, 'Fast-path name invocation');
        this.callState = 'speaking';
        await this.speak(fastPathResponse);
        return;
      }

      // Sentiment check — auto-escalate on frustration
      const escalated = await this.handleSentiment(transcript);
      if (escalated) return;

      // Process through orchestrator
      this.callState = 'thinking';
      let result: any;
      try {
        result = await this.pipelineController.processTurn(transcript);
        this.logger.info({ resultType: result?.type, hasText: !!result?.responseText }, 'Pipeline result');
      } catch (err: any) {
        this.logger.error({ error: err?.message ?? String(err) }, 'Pipeline processTurn error');
        // Fallback: generate direct LLM response
        await this.speak("I'm sorry, I didn't catch that. Could you say that again?");
        return;
      }

      // Track topics for memory persistence
      if (result.intent && !this.topicsDiscussed.includes(result.intent)) {
        this.topicsDiscussed.push(result.intent);
      }

      // Voice intelligence: increment turn, track goals/objections
      const convId = this.callSid ?? 'unknown';
      convStateEngine.incrementTurn(convId);
      turnTakingManager.logEvent(convId, 'speech_end', 0, transcript.substring(0, 60));
      if (result.intent) convStateEngine.addGoal(convId, result.intent);
      // Detect objection keywords
      const lower = transcript.toLowerCase();
      if (/not interested|too expensive|call back later|remove me|stop calling/.test(lower)) {
        convStateEngine.addObjection(convId, lower.match(/not interested|too expensive|call back later|remove me|stop calling/)?.[0] ?? 'objection');
      }

      switch (result.type) {
        case 'respond':
          // Streaming LLM → TTS: sentences are synthesized as they arrive
          this.logger.info({ intent: result.intent, provider: result.provider }, 'Generating streaming LLM response');
          try {
            this.isSpeaking = true;
            this.callState = 'speaking';
            await this.generateStreamingLLMResponse(result, transcript);
          } catch (err: any) {
            this.logger.error({ error: err?.message ?? String(err), stack: err?.stack?.substring(0, 300) }, 'Streaming LLM error');
            await this.speak("I'm having trouble processing that right now. Let me try again.");
          }
          break;

        case 'escalate':
          this.callOutcome = 'escalated';
          await this.speak(result.responseText);
          // Transfer call to human — would trigger Twilio <Dial> or conference
          this.initiateTransfer(result.context);
          break;

        case 'opt_out':
          this.callOutcome = 'opt_out';
          await this.speak(result.responseText);
          // End call after speaking
          setTimeout(() => this.endCall(), 3000);
          break;

        case 'switch_pipeline':
          // Pipeline controller handles the switch internally
          this.logger.info('Switched to Grok speech-to-speech');
          break;

        case 'system_action':
          // Handled internally
          break;

        default:
          // Handle unrecognized result types (e.g. classify_intent)
          // by generating a direct LLM response
          this.logger.info({ type: result.type }, 'Unhandled pipeline result — generating direct response');
          try {
            const directResponse = await this.generateLLMResponse({
              ...result,
              type: 'respond',
              provider: 'gpt-4o',
              intent: result.intent ?? 'general_inquiry',
              userUtterance: transcript,
              responseInstruction: result.responseInstruction ?? `You are ${this.sessionConfig?.model ?? 'an AI assistant'}. Respond conversationally to the caller. Be helpful, warm, and concise.`,
              tools: result.tools ?? [],
              latencyBudget: 800,
            });
            if (directResponse) {
              await this.speak(directResponse);
            }
          } catch (err: any) {
            this.logger.error({ error: err?.message }, 'Direct LLM fallback error');
            await this.speak("I'm here! Let me help you with that.");
          }
          break;
      }
    });

    this.deepgram.on('speechStarted', () => {
      // Immediate barge-in (VOICE-CALL-01 sec 3)
      const convId = this.callSid ?? 'unknown';
      turnTakingManager.detectInterruption(convId, this.isSpeaking);
      this.callState = 'interrupted';
      if (this.isSpeaking) {
        this.clearAgentAudio();
        this.isSpeaking = false;
      }
      this.callState = 'listening';
      this.resetSilenceTimer();
    });

    // Multi-language detection — sync Cartesia TTS language with detected speech language
    this.deepgram.on('languageDetected', (language: string) => {
      if (language !== this.detectedLanguage) {
        this.logger.info({ from: this.detectedLanguage, to: language }, 'Language switch detected');
        this.detectedLanguage = language;
        this.cartesia.setLanguage(language);
      }
    });

    this.deepgram.on('error', (error: Error) => {
      this.logger.error({ error }, 'Deepgram STT error');
    });
  }

  // ==========================================================================
  // Sentiment Detection
  // ==========================================================================

  private detectSentiment(transcript: string): 'positive' | 'neutral' | 'negative' {
    const lower = transcript.toLowerCase();

    const frustrationKeywords = [
      'frustrated', 'angry', 'ridiculous', 'unacceptable',
      'speak to someone', 'human', 'agent', 'supervisor',
      'this is terrible', 'not working', 'waste of time',
      'speak to a human', 'talk to a person', 'real person', 'manager',
      'useless', 'horrible', 'terrible',
      'are you even listening', 'this is insane', 'i give up',
    ];

    const positiveKeywords = [
      'thank you', 'thanks', 'great', 'perfect', 'awesome', 'wonderful',
      'helpful', 'appreciate', 'excellent', 'that works',
    ];

    const frustrationHits = frustrationKeywords.filter(kw => lower.includes(kw)).length;
    const positiveHits = positiveKeywords.filter(kw => lower.includes(kw)).length;

    if (frustrationHits >= 2) return 'negative';
    if (frustrationHits >= 1 && positiveHits === 0) return 'negative';
    if (positiveHits >= 1) return 'positive';
    return 'neutral';
  }

  /**
   * Count frustration keyword matches in a transcript.
   * Used for immediate escalation when 2+ keywords appear in a single turn.
   */
  private countFrustrationKeywords(transcript: string): number {
    const lower = transcript.toLowerCase();
    const frustrationKeywords = [
      'frustrated', 'angry', 'ridiculous', 'unacceptable',
      'speak to someone', 'human', 'agent', 'supervisor',
      'this is terrible', 'not working', 'waste of time',
    ];
    return frustrationKeywords.filter(kw => lower.includes(kw)).length;
  }

  /**
   * Analyze transcript for frustration and update sentiment tracking.
   * Returns true if the call should be auto-escalated to a human.
   */
  private async handleSentiment(transcript: string): Promise<boolean> {
    const sentiment = this.detectSentiment(transcript);
    const frustrationCount = this.countFrustrationKeywords(transcript);

    this.logger.info({ sentiment, frustrationCount, consecutiveNegative: this.consecutiveNegative, sentimentScore: this.sentimentScore }, 'Sentiment analysis');

    if (sentiment === 'negative') {
      this.consecutiveNegative++;
      this.sentimentScore = Math.max(-5, this.sentimentScore - 1);
      this.logger.info({ sentiment, consecutive: this.consecutiveNegative, score: this.sentimentScore }, 'Negative sentiment detected');

      // Auto-escalate: 2+ frustration keywords in a single turn, OR 3+ consecutive negative turns
      if (frustrationCount >= 2 || this.consecutiveNegative >= 3) {
        this.logger.warn({ frustrationCount, consecutiveNegative: this.consecutiveNegative }, 'Auto-escalating due to caller frustration');
        await this.speak("I can hear this has been frustrating, and I'm sorry. Let me connect you with a team member who can help right away.");
        this.initiateTransfer({ reason: 'caller_frustration', sentimentScore: this.sentimentScore, frustrationCount });
        return true; // Escalated
      }
    } else if (sentiment === 'positive') {
      this.consecutiveNegative = 0;
      this.sentimentScore = Math.min(5, this.sentimentScore + 1);
    } else {
      this.consecutiveNegative = 0;
    }

    return false; // Not escalated
  }

  // ==========================================================================
  // Cartesia TTS Handlers
  // ==========================================================================

  private setupCartesiaHandlers(): void {
    this.logger.info('Setting up Cartesia audio handlers');
    this.cartesia.on('audio', (pcm8k: Buffer) => {
      // Cartesia outputs 8kHz PCM directly (matching Twilio's native rate)
      // Just encode to mulaw — no downsampling needed
      const mulaw = pcm16ToMulaw(pcm8k);
      this.sendAudioToTwilio(mulaw);
    });

    this.cartesia.on('done', () => {
      this.isSpeaking = false;
      // Set a mark so we know when Twilio finishes playing
      this.sendMark(`speech_done_${this.markCounter++}`);
    });

    this.cartesia.on('error', (error: Error) => {
      this.logger.error({ error }, 'Cartesia TTS error');
      this.isSpeaking = false;
    });
  }

  // ==========================================================================
  // Audio Output — Agent → Caller
  // ==========================================================================

  private async speak(text: string): Promise<void> {
    const clean = sanitizeForTTS(formatForSpeech(text));
    if (!clean) return;

    this.isSpeaking = true;
    this.callState = 'speaking';
    this.logger.info({ text: clean.substring(0, 80) }, 'Agent speaking');

    await this.cartesia.synthesize(clean);
  }

  private async speakDisclosure(): Promise<void> {
    // In production, this could be a pre-recorded audio file for consistency
    // For now, generate via TTS
    const model = this.sessionConfig?.model ?? 'DMC';
    const disclosures: Record<string, string> = {
      DMC: "Hi, you've reached DMC Banking. I'm an AI assistant here to help. You can ask to speak with a person at any time. How can I help you today?",
      CONSTITUTIONAL_TENDER: "Thank you for calling Constitutional Tender. I'm an AI assistant and can help with pricing, account information, and general questions. For transactions, I can connect you with a specialist. How can I help?",
      TILT: "Thank you for calling TILT Lending. I'm an AI assistant. I can help with loan inquiries, payment information, and scheduling. You can ask for a human at any time. How can I assist you?",
      EUREKA: "Thank you for calling Eureka Settlement Services. I'm an AI assistant. I can help with settlement status and general questions. How can I help today?",
      IFSE: "IFSE Treasury operations. AI assistant. How can I help?",
      JACK: "Hey there! This is Jack from Calculus. How can I help you today?",
      CINDY: "Hi, this is Cindy from Calculus. How can I help you today?",
      BUNNY: "Hey! It's Bunny. Everything's running smooth. What can I help you with?",
      JENNY: "Hi there! It's Jenny. What can I help you with today?",
    };

    await this.speak(disclosures[model] ?? disclosures.DMC);
  }

  // ==========================================================================
  // Twilio Audio Output
  // ==========================================================================

  private sendAudioToTwilio(mulawAudio: Buffer): void {
    if (!this.isStreaming || !this.streamSid) {
      this.logger.debug({ isStreaming: this.isStreaming, hasStreamSid: !!this.streamSid, audioLen: mulawAudio.length }, 'Dropping audio — stream not ready');
      return;
    }

    const message = JSON.stringify({
      event: 'media',
      streamSid: this.streamSid,
      media: {
        payload: mulawAudio.toString('base64'),
      },
    });

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message);
      this.twilioAudioChunksSent += 1;
      if (this.twilioAudioChunksSent % 50 === 1) {
        this.logger.info({ twilioChunks: this.twilioAudioChunksSent, payloadLen: mulawAudio.length }, 'Sending audio to Twilio');
      }
    } else {
      this.logger.warn({ wsState: this.ws.readyState }, 'Cannot send audio — WebSocket not open');
    }
  }

  private clearAgentAudio(): void {
    if (!this.streamSid) return;

    this.logger.debug('Clearing audio queue (barge-in)');

    const message = JSON.stringify({
      event: 'clear',
      streamSid: this.streamSid,
    });

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    }

    // Also cancel any in-flight TTS
    this.cartesia.cancel();
  }

  private sendMark(name: string): void {
    if (!this.streamSid) return;

    this.pendingMarks.add(name);

    const message = JSON.stringify({
      event: 'mark',
      streamSid: this.streamSid,
      mark: { name },
    });

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    }
  }

  private handleMark(msg: TwilioMarkMessage): void {
    const name = msg.mark.name;
    this.pendingMarks.delete(name);

    if (name.startsWith('speech_done_')) {
      this.isSpeaking = false;
    }
  }

  // ==========================================================================
  // LLM Response Generation (Placeholder)
  // ==========================================================================

  /**
   * Generate a response from the routed LLM (GPT-4o or Claude).
   * Executes tool calls via the ToolExecutor service dispatch.
   */
  private async generateLLMResponse(result: any): Promise<string | null> {
    if (!this.sessionConfig) return null;

    const conversationId = this.callSid ?? 'unknown';
    const model = this.sessionConfig.model;
    const provider = result.provider ?? 'gpt-4o';
    const tools = result.tools ?? [];
    const latencyBudget = result.latencyBudget ?? 800;

    const toolSchemas = buildToolSchemas(tools);

    const executor = this.toolExecutor;
    const authTier = result.authTier ?? 0;
    const customerId = result.customerId ?? null;

    // Inject outbound call context into system instruction if present
    let systemInstruction = result.responseInstruction ?? '';
    if (this.outboundMessage) {
      systemInstruction += `\n\nOUTBOUND CALL CONTEXT: You called ${this.outboundRecipientName || 'a client'}. Instructions: ${this.outboundMessage}`;
    }

    const response = await this.llm.generateResponse({
      conversationId,
      provider,
      model,
      intent: result.intent ?? null,
      authTier,
      userUtterance: result.userUtterance ?? '',
      systemInstruction,
      tools: toolSchemas,
      toolExecutor: async (name: string, args: Record<string, unknown>) => {
        return executor.execute(name, args, {
          conversationId,
          model,
          authTier,
          customerId,
        });
      },
      latencyBudgetMs: latencyBudget,
    });

    this.logger.info({
      provider: response.provider,
      latencyMs: response.latencyMs,
      tokensUsed: response.tokensUsed,
      toolCalls: response.toolCalls.length,
      wasFallback: response.wasFallback,
      responseLength: response.text.length,
    }, 'LLM response generated');

    return response.text || null;
  }

  /**
   * Streaming LLM -> TTS: sentences are synthesized as they arrive.
   * Cuts time-to-first-audio by streaming partial responses to Cartesia.
   */
  private async generateStreamingLLMResponse(result: any, transcript: string): Promise<void> {
    if (!this.sessionConfig) return;

    const conversationId = this.callSid ?? 'unknown';
    const model = this.sessionConfig.model;
    const provider = result.provider ?? 'gpt-4o';
    const tools = result.tools ?? [];
    const latencyBudget = result.latencyBudget ?? 800;

    const toolSchemas = buildToolSchemas(tools);
    const executor = this.toolExecutor;
    const authTier = result.authTier ?? 0;
    const customerId = result.customerId ?? null;

    let sentenceBuffer = '';
    let streamingStarted = false;

    // Build agent system instruction (VOICE-CALL-01 sec 9)
    const agentModel = this.sessionConfig?.model ?? 'JACK';
    let streamSystemInstruction = result.responseInstruction ?? '';
    if (!streamSystemInstruction) {
      if (agentModel === 'JACK') {
        streamSystemInstruction = JACK_SYSTEM_PROMPT;
      } else if (agentModel === 'JENNY') {
        streamSystemInstruction = JENNY_SYSTEM_PROMPT;
      } else if (agentModel === 'BUNNY') {
        streamSystemInstruction = buildAgentSystemPrompt('Bunny', 'operations assistant', 'Calculus Research');
      } else if (agentModel === 'CINDY') {
        streamSystemInstruction = CINDY_SYSTEM_PROMPT;
      } else {
        streamSystemInstruction = buildAgentSystemPrompt(String(agentModel), 'representative', 'Calculus');
      }
    }
    if (this.outboundMessage) {
      streamSystemInstruction += '\n\nOUTBOUND CALL CONTEXT: You called ' + (this.outboundRecipientName || 'a client') + '. Instructions: ' + this.outboundMessage;
    }

    // Pacing: apply persona-defined pause before responding (natural turn-taking feel)
    if (this.persona && this.persona.pacingPauseMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.persona!.pacingPauseMs));
    }

    // Log agent turn start for latency tracking
    turnTakingManager.logEvent(this.callSid ?? 'unknown', 'agent_start', 0);

    // Start a streaming Cartesia context — audio begins from first sentence
    await this.cartesia.startStream();

    const response = await this.llm.generateResponseStreaming({
      conversationId,
      provider,
      model,
      intent: result.intent ?? null,
      authTier,
      userUtterance: result.userUtterance ?? transcript,
      systemInstruction: streamSystemInstruction,
      tools: toolSchemas,
      toolExecutor: async (name: string, args: Record<string, unknown>) => {
        return executor.execute(name, args, {
          conversationId, model, authTier, customerId,
        });
      },
      latencyBudgetMs: latencyBudget,
      onChunk: (text: string, isDone: boolean) => {
        if (isDone) {
          // End the streaming context with any remaining text
          this.cartesia.endStream(sentenceBuffer.trim() || undefined);
          sentenceBuffer = '';
          streamingStarted = false;
          // isSpeaking stays true until Twilio echoes the mark
          this.cartesia.resetContext();
          this.sendMark(`speech_done_${this.markCounter++}`);
          return;
        }
        if (text.trim()) {
          sentenceBuffer += text;
          // Stream to Cartesia at sentence boundaries for natural pacing
          // Detect sentence-ending punctuation
          const sentenceEnd = /[.!?;:]\s*$/;
          if (sentenceEnd.test(sentenceBuffer)) {
            const cleanSentence = sanitizeForTTS(formatForSpeech(sentenceBuffer.trim()));
            if (cleanSentence) {
              this.cartesia.streamText(cleanSentence);
              streamingStarted = true;
            }
            sentenceBuffer = '';
          }
        }
      },
    });

    this.logger.info({
      provider: response.provider,
      latencyMs: response.latencyMs,
      tokensUsed: response.tokensUsed,
      toolCalls: response.toolCalls.length,
      wasFallback: response.wasFallback,
      streaming: true,
    }, 'Streaming LLM response complete');
  }

  // ==========================================================================
  // Call Control
  // ==========================================================================


  // Silence Recovery (VOICE-CALL-01-CONFIG sec 10)
  private resetSilenceTimer(): void {
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (!this.isStreaming) return;
    this.silenceTimer = setTimeout(async () => {
      if (this.isStreaming && !this.isSpeaking && this.callState === 'listening') {
        this.logger.info('Silence timeout');
        await this.speak('Are you still there?');
      }
    }, TwilioMediaStreamHandler.SILENCE_TIMEOUT_MS);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
  }

  private initiateTransfer(context: Record<string, unknown>): void {
    this.logger.info({ context }, 'Initiating transfer to human');
    // In production: use Twilio REST API to update the call
    // with a <Dial> to the appropriate queue/agent
  }

  private async endCall(): Promise<void> {
    this.logger.info({ callSid: this.callSid }, 'Ending call');
    await this.pipelineController.endCall('completed');
    this.cleanup();
    this.ws.close(1000, 'call_ended');
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  private async cleanup(): Promise<void> {
    this.isStreaming = false;

    // Log call outcome to jsonl (SWARM-VOICE-INTELLIGENCE-153)
    if (this.sessionConfig && this.callStartTime) {
      const convId = this.callSid ?? 'unknown';
      const convState = convStateEngine.get(convId);
      const durationSec = Math.round((Date.now() - this.callStartTime.getTime()) / 1000);
      callOutcomeLogger.log({
        timestamp: new Date().toISOString(),
        callSid: this.callSid ?? 'unknown',
        callerPhone: this.sessionConfig.callerPhone,
        calledPhone: this.sessionConfig.calledPhone,
        agentModel: String(this.sessionConfig.model),
        outcome: this.callOutcome,
        durationSec,
        turnCount: convState?.turnCount ?? 0,
        phase: (convState?.phase ?? 'greeting') as ConvPhase,
        goals: convState?.goals ?? [],
        objections: convState?.objections ?? [],
        interruptionCount: turnTakingManager.getInterruptionCount(convId),
        sentimentScore: this.sentimentScore,
        language: this.detectedLanguage,
      });
      convStateEngine.delete(convId);
    }

    // Save call summary to conversation memory
    if (this.sessionConfig?.callerPhone && this.callStartTime) {
      try {
        const durationSec = Math.round((Date.now() - this.callStartTime.getTime()) / 1000);
        const agentName = this.sessionConfig.model || 'JACK';
        const sentiment = this.sentimentScore >= 1 ? 'positive' as const
          : this.sentimentScore <= -1 ? 'negative' as const
          : 'neutral' as const;

        await this.conversationMemory.saveCallSummary(this.sessionConfig.callerPhone, {
          date: new Date().toISOString(),
          agent: agentName,
          durationSec,
          topicsDiscussed: this.topicsDiscussed.length > 0 ? this.topicsDiscussed : ['general_inquiry'],
          outcome: this.callOutcome,
          sentiment,
          notes: `${durationSec}s call with ${agentName}. Language: ${this.detectedLanguage}.`,
        });
        this.logger.info({ phone: this.sessionConfig.callerPhone, durationSec, outcome: this.callOutcome }, 'Call summary saved to memory');
      } catch (err: any) {
        this.logger.warn({ error: err?.message }, 'Failed to save call summary to memory');
      }
    }

    try {
      await this.deepgram.stopStream();
    } catch { /* ignore */ }

    try {
      this.cartesia.cancel();
    } catch { /* ignore */ }

    if (this.pipelineController.getSession()) {
      try {
        await this.pipelineController.endCall('disconnected');
      } catch { /* ignore */ }
    }
  }
}
