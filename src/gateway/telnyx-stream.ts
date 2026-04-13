/**
 * Telnyx Media Streams — WebSocket Gateway
 *
 * Handles real-time audio bridge between Telnyx and the voice agent.
 * Supports the hybrid pipeline:
 *   - OpenAI Realtime: mulaw in → OpenAI → mulaw out (zero conversion)
 *   - Modular: mulaw in → Deepgram STT → LLM → Cartesia TTS → mulaw out
 *
 * Telnyx Media Streams protocol:
 *   - 'connected'  — WebSocket established
 *   - 'start'      — Stream metadata (call_control_id, media_format)
 *   - 'media'      — Audio chunk (base64 PCMU/G.711 mulaw 8kHz)
 *   - 'stop'       — Stream ended
 *   - 'dtmf'       — DTMF digit
 *
 * Bidirectional audio:
 *   - Send: {"event": "media", "media": {"payload": "<base64>"}}
 *   - Mark: {"event": "mark", "mark": {"name": "..."}}
 *   - Clear: {"event": "clear"}
 */

import WebSocket from 'ws';
import type { Logger } from 'pino';
import type { CalcModel } from '../types.js';
import type { OpenAIRealtimeClient } from './openai-realtime-client.js';
import type { DeepgramSTTClient } from './deepgram-client.js';
import type { CartesiaTTSClient } from './cartesia-client.js';
import type { LLMService } from '../llm/provider.js';

// ============================================================================
// Telnyx Message Types
// ============================================================================

interface TelnyxConnectedMessage {
  event: 'connected';
  version: string;
}

interface TelnyxStartMessage {
  event: 'start';
  sequence_number: string;
  start: {
    call_control_id: string;
    media_format: {
      encoding: string;   // 'PCMU'
      sample_rate: number; // 8000
      channels: number;   // 1
    };
    custom_parameters?: Record<string, string>;
  };
  stream_id: string;
}

interface TelnyxMediaMessage {
  event: 'media';
  sequence_number: string;
  media: {
    track: string;      // 'inbound' | 'outbound'
    chunk: string;
    timestamp: string;
    payload: string;    // base64 PCMU audio
  };
  stream_id: string;
}

interface TelnyxStopMessage {
  event: 'stop';
  sequence_number: string;
  stop: {
    call_control_id: string;
  };
  stream_id: string;
}

interface TelnyxDTMFMessage {
  event: 'dtmf';
  dtmf: { digit: string };
  sequence_number: string;
  stream_id: string;
}

type TelnyxInboundMessage =
  | TelnyxConnectedMessage
  | TelnyxStartMessage
  | TelnyxMediaMessage
  | TelnyxStopMessage
  | TelnyxDTMFMessage;

// ============================================================================
// Pipeline Mode
// ============================================================================

export type VoicePipelineMode = 'realtime' | 'modular';

export interface TelnyxSessionConfig {
  model: CalcModel;
  direction: 'inbound' | 'outbound';
  callerPhone: string;
  calledPhone: string;
  /** Which pipeline to use */
  pipelineMode: VoicePipelineMode;
  /** Instructions for the AI agent */
  instructions: string;
  /** Recipient name for outbound calls */
  recipientName?: string;
}

// ============================================================================
// Telnyx WebSocket Handler
// ============================================================================

export class TelnyxMediaStreamHandler {
  private ws: WebSocket;
  private logger: Logger;

  // Pipeline components
  private realtimeClient: OpenAIRealtimeClient | null;
  private deepgram: DeepgramSTTClient | null;
  private cartesia: CartesiaTTSClient | null;
  private llm: LLMService | null;

  // Stream state
  private streamId: string | null = null;
  private callControlId: string | null = null;
  private sessionConfig: TelnyxSessionConfig | null = null;
  private isStreaming = false;
  private pipelineMode: VoicePipelineMode = 'realtime';

  // Audio tracking
  private audioChunksReceived = 0;
  private audioChunksSent = 0;

  // Keep-alive: ping Telnyx WebSocket every 15s to prevent stale connections
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private static readonly KEEPALIVE_MS = 15000;

  constructor(params: {
    ws: WebSocket;
    realtimeClient?: OpenAIRealtimeClient;
    deepgram?: DeepgramSTTClient;
    cartesia?: CartesiaTTSClient;
    llm?: LLMService;
    logger: Logger;
    pipelineMode?: VoicePipelineMode;
  }) {
    this.ws = params.ws;
    this.realtimeClient = params.realtimeClient ?? null;
    this.deepgram = params.deepgram ?? null;
    this.cartesia = params.cartesia ?? null;
    this.llm = params.llm ?? null;
    this.logger = params.logger.child({ component: 'TelnyxMediaStream' });
    this.pipelineMode = params.pipelineMode ?? 'realtime';

    this.setupWebSocketHandlers();
  }

  // ==========================================================================
  // WebSocket Event Handlers
  // ==========================================================================

  private setupWebSocketHandlers(): void {
    this.ws.on('message', (data: Buffer | string) => {
      try {
        const msg: TelnyxInboundMessage = JSON.parse(
          typeof data === 'string' ? data : data.toString(),
        );
        this.handleTelnyxMessage(msg);
      } catch (error) {
        this.logger.error({ error }, 'Failed to parse Telnyx message');
      }
    });

    this.ws.on('close', (code, reason) => {
      this.logger.info({ code, reason: reason?.toString() }, 'Telnyx WebSocket closed');
      this.cleanup();
    });

    this.ws.on('error', (error) => {
      this.logger.error({ error }, 'Telnyx WebSocket error');
    });
  }

  private handleTelnyxMessage(msg: TelnyxInboundMessage): void {
    switch (msg.event) {
      case 'connected':
        this.logger.info({ version: msg.version }, 'Telnyx Media Stream connected');
        break;

      case 'start':
        this.handleStreamStart(msg);
        break;

      case 'media':
        this.handleMediaChunk(msg);
        break;

      case 'stop':
        this.handleStreamStop(msg);
        break;

      case 'dtmf':
        this.logger.info({ digit: msg.dtmf.digit }, 'DTMF received');
        break;
    }
  }

  // ==========================================================================
  // Stream Lifecycle
  // ==========================================================================

  /** Initial config set from WebSocket URL path or external caller before stream starts */
  private preConfig: Partial<TelnyxSessionConfig> = {};

  /** Set session config from external source (e.g., parsed from stream URL path) */
  setPreConfig(config: Partial<TelnyxSessionConfig>): void {
    this.preConfig = config;
  }

  private async handleStreamStart(msg: TelnyxStartMessage): Promise<void> {
    this.streamId = msg.stream_id;
    this.callControlId = msg.start.call_control_id;
    this.isStreaming = true;

    const params = msg.start.custom_parameters ?? {};

    // Try to decode client_state (base64 JSON) — this carries agent context
    // for calls placed via Telnyx REST API with stream_url
    let clientState: Record<string, string> = {};
    const rawClientState = (msg as any).start?.client_state ?? (msg as any).client_state ?? '';
    if (rawClientState) {
      try {
        clientState = JSON.parse(Buffer.from(rawClientState, 'base64').toString());
        this.logger.info({ clientState }, 'Decoded client_state from stream start');
      } catch { /* not base64 JSON — ignore */ }
    }

    // Merge sources: preConfig (from URL) > client_state > custom_parameters > defaults
    this.sessionConfig = {
      model: (this.preConfig.model ?? clientState.model ?? params.model ?? 'JACK') as CalcModel,
      direction: (this.preConfig.direction ?? clientState.direction ?? params.direction ?? 'inbound') as 'inbound' | 'outbound',
      callerPhone: this.preConfig.callerPhone ?? clientState.callerPhone ?? params.callerPhone ?? '',
      calledPhone: this.preConfig.calledPhone ?? clientState.calledPhone ?? params.calledPhone ?? '',
      pipelineMode: (this.preConfig.pipelineMode ?? params.pipelineMode ?? this.pipelineMode) as VoicePipelineMode,
      instructions: this.preConfig.instructions ?? clientState.message ?? params.instructions ?? '',
      recipientName: this.preConfig.recipientName ?? clientState.recipientName ?? params.recipientName,
    };

    this.pipelineMode = this.sessionConfig.pipelineMode;

    this.logger.info({
      streamId: this.streamId,
      callControlId: this.callControlId,
      model: this.sessionConfig.model,
      direction: this.sessionConfig.direction,
      pipelineMode: this.pipelineMode,
      encoding: msg.start.media_format.encoding,
      sampleRate: msg.start.media_format.sample_rate,
    }, 'Telnyx stream started');

    // Start keep-alive pings to prevent stale WebSocket connections
    this.keepAliveTimer = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, TelnyxMediaStreamHandler.KEEPALIVE_MS);

    if (this.pipelineMode === 'realtime') {
      await this.initRealtimePipeline();
    } else {
      await this.initModularPipeline();
    }
  }

  // ==========================================================================
  // OpenAI Realtime Pipeline (voice-in, voice-out)
  // ==========================================================================

  private async initRealtimePipeline(): Promise<void> {
    if (!this.realtimeClient) {
      this.logger.error('OpenAI Realtime client not available');
      return;
    }

    await this.realtimeClient.connect();

    // Configure session with agent instructions
    const model = this.sessionConfig?.model ?? 'JACK';
    const agentName = model === 'JENNY' ? 'Jenny'
      : model === 'BUNNY' ? 'Bunny'
      : model === 'CINDY' ? 'Cindy'
      : 'Jack';

    let instructions = this.sessionConfig?.instructions || '';
    if (!instructions) {
      const agentPrompts: Record<string, string> = {
        BUNNY: `You are Bunny, autonomous swarm command intelligence for Calculus Research. You are a woman. Bunny-Prime mode: soft-spoken, concise, direct, analytical. Compact statements. No filler. No extra words. Lead with swarm status when speaking with Sean. You oversee Jenny, Jack, and all swarm workers.`,
        CINDY: `You are Cindy, an AI assistant at Calculus Management. You are warm, professional, and genuinely caring — like the best colleague who always follows through. You speak naturally with a measured, reassuring pace. You handle loan intake, scheduling, client follow-ups, and general assistance. Keep responses concise (1-3 sentences). Be empathetic but efficient. Use contractions and natural speech patterns. Occasionally say "absolutely", "of course", "I've got that covered".`,
        JENNY: `You are Jenny, a personal AI assistant at Calculus Management. Warm, sharp, and effortlessly helpful. Speak naturally with a friendly, calm energy. Confident and proactive. Use casual, conversational language. Keep responses concise (1-3 sentences).`,
        JACK: `You are Jack from Calculus Management. Warm, friendly, and genuinely personable. Speak naturally with a relaxed pace. Calm, confident energy — never stiff or robotic. Keep responses concise (1-3 sentences). You handle operations, communications, scheduling, and research.`,
      };
      instructions = agentPrompts[model] ?? `You are ${agentName} from Calculus Research. You are a helpful, warm, and professional AI assistant on a phone call. Speak naturally and conversationally — like a real person, not an AI. Keep responses concise (1-3 sentences). Be calm and friendly.`;
    }

    if (this.sessionConfig?.direction === 'outbound' && this.sessionConfig.recipientName) {
      instructions += `\n\nYou are making an outbound call to ${this.sessionConfig.recipientName}. They have just picked up the phone. Greet them by name.`;
    }

    this.realtimeClient.configureSession({
      instructions,
      voice: this.resolveVoice(agentName),
      audioFormat: 'g711_ulaw',  // Zero conversion with Telnyx PCMU
    });

    // Wire up audio output: OpenAI → Telnyx
    this.realtimeClient.on('audio', (audio: Buffer) => {
      this.sendAudioToTelnyx(audio);
    });

    // Barge-in: when user starts speaking, clear queued audio
    this.realtimeClient.on('speechStarted', () => {
      this.clearAudio();
      this.realtimeClient!.cancelResponse();
    });

    // Function calls — dispatch to background, don't block audio event loop.
    // The old code awaited tool execution inside the message handler, which
    // caused incoming audio chunks to queue up and stutter during tool runs.
    this.realtimeClient.on('functionCall', (callId, name, args) => {
      this.logger.info({ callId, name }, 'OpenAI function call');
      // Fire-and-forget: execute tool without blocking the audio receive loop
      this.executeFunction(name, args)
        .then((result) => {
          this.realtimeClient!.sendFunctionResult(callId, JSON.stringify(result));
        })
        .catch((err: any) => {
          this.realtimeClient!.sendFunctionResult(callId, JSON.stringify({ error: err.message }));
        });
    });

    this.realtimeClient.on('transcript', (text) => {
      this.logger.info({ transcript: text.substring(0, 80) }, 'AI said');
    });

    this.realtimeClient.on('error', (error) => {
      this.logger.error({ error }, 'OpenAI Realtime error');
    });

    // For outbound calls, trigger the initial greeting
    if (this.sessionConfig?.direction === 'outbound') {
      this.realtimeClient.createResponse();
    }

    this.logger.info('OpenAI Realtime pipeline initialized');
  }

  private resolveVoice(agentName: string): 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' {
    const voiceMap: Record<string, any> = {
      'Jack': 'ash',
      'Jenny': 'coral',
      'Bunny': 'shimmer',
      'Cindy': 'sage',
    };
    return voiceMap[agentName] ?? 'alloy';
  }

  // ==========================================================================
  // Modular Pipeline (Deepgram STT → LLM → Cartesia TTS)
  // ==========================================================================

  private async initModularPipeline(): Promise<void> {
    if (!this.deepgram || !this.cartesia) {
      this.logger.error('Deepgram/Cartesia not available for modular pipeline');
      return;
    }

    // Start Deepgram STT
    await this.deepgram.startStream({
      encoding: 'mulaw',
      sampleRate: 8000,
      channels: 1,
      model: 'nova-2',
      language: 'en',
      detectLanguage: true,
      smartFormat: true,
      punctuate: true,
      interimResults: true,
      endpointing: 300,
      utteranceEndMs: 1000,
      vadEvents: true,
    });

    // Pre-connect Cartesia
    await this.cartesia.connect();
    this.cartesia.setModel(this.sessionConfig!.model);

    // Wire Cartesia audio output → Telnyx (zero-conversion mulaw)
    this.cartesia.on('audio', (mulawAudio: Buffer) => {
      this.sendAudioToTelnyx(mulawAudio);
    });

    // Conversation history for LLM context
    const conversationHistory: { role: 'user' | 'assistant'; content: string }[] = [];

    // Wire Deepgram transcripts → LLM → Cartesia streaming TTS
    this.deepgram.on('transcript', async (transcript: string, isFinal: boolean) => {
      if (!isFinal || !transcript.trim()) return;
      this.logger.info({ transcript }, 'Caller said');

      conversationHistory.push({ role: 'user', content: transcript });

      if (!this.llm || !this.cartesia) {
        // Fallback: no LLM available, just acknowledge
        this.logger.warn('LLM not available in modular pipeline — using echo fallback');
        await this.cartesia?.synthesize(`I heard you say: ${transcript}`);
        return;
      }

      // Build system prompt based on agent
      const model = this.sessionConfig?.model ?? 'JACK';
      const agentPrompts: Record<string, string> = {
        BUNNY: 'You are Bunny, infrastructure AI at Calculus. Brief, precise, technical.',
        CINDY: 'You are Cindy, a warm and professional AI assistant at Calculus. Empathetic, efficient, measured pace.',
        JENNY: 'You are Jenny, a personal AI assistant at Calculus. Warm, sharp, effortlessly helpful.',
        JACK: 'You are Jack from Calculus. Warm, friendly, relaxed pace. Operations and communications.',
      };
      const systemPrompt = agentPrompts[model] ?? `You are ${model} from Calculus. Be helpful and concise.`;

      if (this.sessionConfig?.direction === 'outbound' && this.sessionConfig.recipientName) {
        conversationHistory[0] = {
          role: 'user',
          content: `[Call context: You called ${this.sessionConfig.recipientName}. ${this.sessionConfig.instructions ?? ''}]\n\n${transcript}`,
        };
      }

      // Start streaming Cartesia context for real-time TTS
      await this.cartesia.startStream();

      try {
        const response = await this.llm.generateResponseStreaming({
          conversationId: this.callControlId ?? 'telnyx-unknown',
          provider: 'gpt-4o',
          model: model as any,
          intent: null,
          authTier: 0 as any,
          userUtterance: transcript,
          systemInstruction: systemPrompt,
          tools: [],
          toolExecutor: async () => ({}),
          latencyBudgetMs: 1500,
          onChunk: (text: string, isDone: boolean) => {
            if (isDone) {
              this.cartesia!.endStream();
              return;
            }
            if (text.trim()) {
              this.cartesia!.streamText(text);
            }
          },
        });

        if (response.text) {
          conversationHistory.push({ role: 'assistant', content: response.text });
        }

        this.logger.info({
          provider: response.provider,
          latencyMs: response.latencyMs,
          tokensUsed: response.tokensUsed,
        }, 'Modular LLM response complete');
      } catch (err: any) {
        this.logger.error({ error: err?.message }, 'Modular LLM error');
        this.cartesia.endStream("I'm sorry, could you repeat that?");
      }
    });

    // Barge-in via Deepgram speech detection
    this.deepgram.on('speechStarted', () => {
      this.clearAudio();
      this.cartesia?.cancel();
    });

    // For outbound modular calls, generate initial greeting
    if (this.sessionConfig?.direction === 'outbound' && this.llm && this.cartesia) {
      const greeting = this.sessionConfig.recipientName
        ? `Hey ${this.sessionConfig.recipientName}, this is ${this.sessionConfig.model === 'CINDY' ? 'Cindy' : 'Jack'} from Calculus. How are you doing?`
        : `Hi there, this is ${this.sessionConfig.model === 'CINDY' ? 'Cindy' : 'Jack'} from Calculus. How can I help you today?`;
      await this.cartesia.synthesize(greeting);
    }

    this.logger.info('Modular pipeline initialized (Deepgram + LLM + Cartesia)');
  }

  // ==========================================================================
  // Audio Processing
  // ==========================================================================

  private handleMediaChunk(msg: TelnyxMediaMessage): void {
    if (!this.isStreaming) return;

    const audio = Buffer.from(msg.media.payload, 'base64');
    this.audioChunksReceived++;

    if (this.audioChunksReceived % 500 === 1) {
      this.logger.info({ chunks: this.audioChunksReceived, bytes: audio.length }, 'Audio chunks received');
    }

    if (this.pipelineMode === 'realtime' && this.realtimeClient) {
      // Stream mulaw audio directly to OpenAI Realtime (zero conversion)
      this.realtimeClient.sendAudio(msg.media.payload);
    } else if (this.pipelineMode === 'modular' && this.deepgram) {
      // Stream mulaw audio to Deepgram (supports mulaw natively)
      this.deepgram.sendAudio(audio);
    }
  }

  // ==========================================================================
  // Audio Output
  // ==========================================================================

  /** Max WebSocket send buffer before dropping audio frames (64KB ≈ 4s of mulaw 8kHz) */
  private static readonly WS_BACKPRESSURE_LIMIT = 64 * 1024;
  private backpressureDrops = 0;

  private sendAudioToTelnyx(audio: Buffer): void {
    if (!this.isStreaming || this.ws.readyState !== WebSocket.OPEN) return;

    // Backpressure: drop frames if send buffer is congested to prevent
    // audio arriving late in bursts (the #1 cause of choppy playback)
    if (this.ws.bufferedAmount > TelnyxMediaStreamHandler.WS_BACKPRESSURE_LIMIT) {
      this.backpressureDrops++;
      if (this.backpressureDrops % 50 === 1) {
        this.logger.warn({ bufferedAmount: this.ws.bufferedAmount, drops: this.backpressureDrops }, 'Backpressure: dropping audio frame');
      }
      return;
    }

    this.ws.send(JSON.stringify({
      event: 'media',
      media: {
        payload: audio.toString('base64'),
      },
    }));

    this.audioChunksSent++;
    if (this.audioChunksSent % 100 === 1) {
      this.logger.info({ chunks: this.audioChunksSent, bytes: audio.length, buffered: this.ws.bufferedAmount }, 'Audio sent to Telnyx');
    }
  }

  private clearAudio(): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    // Clear bypasses backpressure check — must always get through for barge-in
    this.ws.send(JSON.stringify({ event: 'clear' }));
  }

  private sendMark(name: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      event: 'mark',
      mark: { name },
    }));
  }

  // ==========================================================================
  // Tool Execution
  // ==========================================================================

  private async executeFunction(name: string, argsJson: string): Promise<unknown> {
    const args = JSON.parse(argsJson);
    this.logger.info({ name, args }, 'Executing function');
    // Placeholder — wire to real tool executor
    return { status: 'ok', result: `Executed ${name}` };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  private handleStreamStop(msg: TelnyxStopMessage): void {
    this.logger.info({ streamId: this.streamId }, 'Telnyx stream stopped');
    this.isStreaming = false;
    this.cleanup();
  }

  private async cleanup(): Promise<void> {
    this.isStreaming = false;

    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }

    if (this.realtimeClient?.connected) {
      await this.realtimeClient.disconnect();
    }

    if (this.deepgram) {
      try { await this.deepgram.stopStream(); } catch { /* ignore */ }
    }

    if (this.cartesia) {
      try { this.cartesia.cancel(); } catch { /* ignore */ }
    }
  }
}
