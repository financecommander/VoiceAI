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

  private async handleStreamStart(msg: TelnyxStartMessage): Promise<void> {
    this.streamId = msg.stream_id;
    this.callControlId = msg.start.call_control_id;
    this.isStreaming = true;

    const params = msg.start.custom_parameters ?? {};

    this.sessionConfig = {
      model: (params.model as CalcModel) ?? ('JACK' as CalcModel),
      direction: (params.direction as 'inbound' | 'outbound') ?? 'inbound',
      callerPhone: params.callerPhone ?? '',
      calledPhone: params.calledPhone ?? '',
      pipelineMode: (params.pipelineMode as VoicePipelineMode) ?? this.pipelineMode,
      instructions: params.instructions ?? '',
      recipientName: params.recipientName,
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
    const agentName = this.sessionConfig?.model === 'JENNY' ? 'Jenny'
      : this.sessionConfig?.model === 'BUNNY' ? 'Bunny'
      : 'Jack';

    let instructions = this.sessionConfig?.instructions || '';
    if (!instructions) {
      if (this.sessionConfig?.model === 'BUNNY') {
        instructions = `You are Bunny, autonomous swarm command intelligence for Calculus Research. You are a woman. Bunny-Prime mode: soft-spoken, concise, direct, analytical. Compact statements. No filler. No extra words. Lead with swarm status when speaking with Sean. You oversee Jenny, Jack, and all swarm workers.`;
      } else {
        instructions = `You are ${agentName} from Calculus Research. You are a helpful, warm, and professional AI assistant on a phone call. Speak naturally and conversationally — like a real person, not an AI. Keep responses concise (1-3 sentences). Be calm and friendly.`;
      }
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
    // Map agent names to OpenAI voices
    const voiceMap: Record<string, any> = {
      'Jack': 'ash',
      'Jenny': 'coral',
      'Bunny': 'shimmer',
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

    // Wire Deepgram transcripts → LLM → Cartesia
    this.deepgram.on('transcript', async (transcript: string, isFinal: boolean) => {
      if (!isFinal || !transcript.trim()) return;
      this.logger.info({ transcript }, 'Caller said');

      // Generate response via LLM and speak it
      // (simplified — full implementation would use pipeline controller)
      if (this.cartesia) {
        await this.cartesia.synthesize(transcript);
      }
    });

    // Barge-in via Deepgram speech detection
    this.deepgram.on('speechStarted', () => {
      this.clearAudio();
      this.cartesia?.cancel();
    });

    this.logger.info('Modular pipeline initialized (Deepgram + Cartesia)');
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
