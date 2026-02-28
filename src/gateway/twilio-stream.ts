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
  private logger: Logger;

  private streamSid: string | null = null;
  private callSid: string | null = null;
  private sessionConfig: TwilioSessionConfig | null = null;
  private isStreaming = false;
  private markCounter = 0;

  // Audio buffering for barge-in detection
  private isSpeaking = false;  // Is the agent currently speaking?
  private pendingMarks: Set<string> = new Set();

  constructor(params: {
    ws: WebSocket;
    pipelineController: VoicePipelineController;
    deepgram: DeepgramSTTClient;
    cartesia: CartesiaTTSClient;
    llm: LLMService;
    toolExecutor: ToolExecutor;
    logger: Logger;
  }) {
    this.ws = params.ws;
    this.pipelineController = params.pipelineController;
    this.deepgram = params.deepgram;
    this.cartesia = params.cartesia;
    this.llm = params.llm;
    this.toolExecutor = params.toolExecutor;
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
    const model = (params.model as CalcModel) ?? resolveModelFromNumber(params.calledPhone ?? '');

    this.sessionConfig = {
      model,
      direction: (params.direction as 'inbound' | 'outbound') ?? 'inbound',
      callerPhone: params.callerPhone ?? '',
      calledPhone: params.calledPhone ?? '',
      initialAuthTier: 0 as AuthTier,
    };

    this.logger.info({
      streamSid: this.streamSid,
      callSid: this.callSid,
      model,
      direction: this.sessionConfig.direction,
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

    // Start Deepgram STT stream
    await this.deepgram.startStream({
      encoding: 'linear16',
      sampleRate: 16000,
      channels: 1,
      model: 'nova-3',
      language: 'en',
      smartFormat: true,
      punctuate: true,
      interimResults: true,
      endpointing: 300,
      utteranceEndMs: 1000,
      vadEvents: true,
    });

    // Deliver disclosure (first thing the caller hears)
    const firstTurn = await this.pipelineController.processTurn('');
    if (firstTurn.type === 'system_action' && firstTurn.action === 'deliver_disclosure') {
      await this.speakDisclosure();
    }
  }

  private handleStreamStop(): void {
    this.logger.info({ callSid: this.callSid }, 'Stream stopped');
    this.isStreaming = false;
    this.cleanup();
  }

  // ==========================================================================
  // Audio Processing — Inbound (Caller → Agent)
  // ==========================================================================

  private handleMediaChunk(msg: TwilioMediaMessage): void {
    if (!this.isStreaming) return;

    const mulawAudio = Buffer.from(msg.media.payload, 'base64');

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

    // Modular pipeline: mulaw → PCM → upsample → Deepgram
    const pcm8k = mulawToPCM16(mulawAudio);
    const pcm16k = upsample8to16(pcm8k);

    // Barge-in detection: if caller is speaking while agent is speaking
    if (this.isSpeaking) {
      // Clear agent audio queue — caller is interrupting
      this.clearAgentAudio();
      this.isSpeaking = false;
    }

    // Send to Deepgram STT
    this.deepgram.sendAudio(pcm16k);
  }

  // ==========================================================================
  // Deepgram STT Handlers
  // ==========================================================================

  private setupDeepgramHandlers(): void {
    this.deepgram.on('transcript', async (transcript: string, isFinal: boolean) => {
      if (!isFinal) return; // Only process final transcripts
      if (!transcript.trim()) return;

      this.logger.info({ transcript }, 'Caller said');

      // Process through orchestrator
      const result = await this.pipelineController.processTurn(transcript);

      switch (result.type) {
        case 'respond':
          // Generate LLM response, then TTS
          const llmResponse = await this.generateLLMResponse(result);
          if (llmResponse) {
            await this.speak(llmResponse);
          }
          break;

        case 'escalate':
          await this.speak(result.responseText);
          // Transfer call to human — would trigger Twilio <Dial> or conference
          this.initiateTransfer(result.context);
          break;

        case 'opt_out':
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
      }
    });

    this.deepgram.on('speechStarted', () => {
      // Caller started speaking — barge-in
      if (this.isSpeaking) {
        this.clearAgentAudio();
        this.isSpeaking = false;
      }
    });

    this.deepgram.on('error', (error: Error) => {
      this.logger.error({ error }, 'Deepgram STT error');
    });
  }

  // ==========================================================================
  // Cartesia TTS Handlers
  // ==========================================================================

  private setupCartesiaHandlers(): void {
    this.cartesia.on('audio', (pcm16k: Buffer) => {
      // Downsample 16kHz → 8kHz, encode to mulaw, send to Twilio
      const pcm8k = downsample16to8(pcm16k);
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
    if (!text.trim()) return;

    this.isSpeaking = true;
    this.logger.info({ text: text.substring(0, 80) }, 'Agent speaking');

    await this.cartesia.synthesize(text);
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
    };

    await this.speak(disclosures[model] ?? disclosures.DMC);
  }

  // ==========================================================================
  // Twilio Audio Output
  // ==========================================================================

  private sendAudioToTwilio(mulawAudio: Buffer): void {
    if (!this.isStreaming || !this.streamSid) return;

    const message = JSON.stringify({
      event: 'media',
      streamSid: this.streamSid,
      media: {
        payload: mulawAudio.toString('base64'),
      },
    });

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message);
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

    const response = await this.llm.generateResponse({
      conversationId,
      provider,
      model,
      intent: result.intent ?? null,
      authTier,
      userUtterance: result.userUtterance ?? '',
      systemInstruction: result.responseInstruction ?? '',
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

  // ==========================================================================
  // Call Control
  // ==========================================================================

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
