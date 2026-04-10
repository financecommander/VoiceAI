/**
 * OpenAI Realtime API Client
 *
 * Voice-to-voice conversation via OpenAI's WebSocket Realtime API.
 * Sub-500ms latency for natural phone conversations.
 *
 * Supports:
 *   - Streaming audio in/out (G.711 mulaw 8kHz for telephony)
 *   - Semantic VAD (automatic turn detection)
 *   - Function calling (tool execution mid-conversation)
 *   - Session configuration (voice, instructions, tools)
 *
 * Used as the "fast path" in the hybrid pipeline:
 *   Telnyx/Twilio → OpenAI Realtime (voice-in, voice-out) → Telnyx/Twilio
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { Logger } from 'pino';

// ============================================================================
// Configuration
// ============================================================================

export interface OpenAIRealtimeConfig {
  apiKey: string;
  model: string;  // 'gpt-4o-realtime-preview' or dated variant
  voice: OpenAIVoice;
  instructions: string;
  /** Audio format for input/output — g711_ulaw for telephony zero-conversion */
  audioFormat: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  /** Turn detection mode */
  turnDetection: 'server_vad' | 'semantic_vad' | 'none';
  /** Tools/functions available during conversation */
  tools: OpenAIRealtimeTool[];
  /** Temperature for responses */
  temperature: number;
  /** Max response tokens */
  maxResponseOutputTokens: number | 'inf';
}

export type OpenAIVoice = 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse';

export interface OpenAIRealtimeTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const DEFAULT_REALTIME_CONFIG: Partial<OpenAIRealtimeConfig> = {
  model: 'gpt-4o-realtime-preview',
  voice: 'alloy',
  audioFormat: 'g711_ulaw',     // Zero-conversion with Telnyx/Twilio mulaw
  turnDetection: 'server_vad',
  temperature: 0.7,
  maxResponseOutputTokens: 4096,
  tools: [],
};

// ============================================================================
// Event Types
// ============================================================================

export interface RealtimeEvents {
  /** Raw audio chunk from OpenAI (mulaw bytes for telephony) */
  audio: (audio: Buffer) => void;
  /** Transcript of what the AI said */
  transcript: (text: string) => void;
  /** User speech detected (for barge-in) */
  speechStarted: () => void;
  /** User speech ended */
  speechStopped: () => void;
  /** AI response complete */
  responseDone: () => void;
  /** Function call requested by AI */
  functionCall: (callId: string, name: string, args: string) => void;
  /** Session created/updated */
  sessionReady: () => void;
  /** Error */
  error: (error: Error) => void;
  /** Connection state changed */
  connectionState: (state: 'connecting' | 'connected' | 'disconnected') => void;
}

// ============================================================================
// OpenAI Realtime Client
// ============================================================================

export class OpenAIRealtimeClient extends EventEmitter {
  private config: OpenAIRealtimeConfig;
  private ws: WebSocket | null = null;
  private logger: Logger;
  private isConnected = false;
  private sessionId: string | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(config: Partial<OpenAIRealtimeConfig> & { apiKey: string }, logger: Logger) {
    super();
    this.config = { ...DEFAULT_REALTIME_CONFIG, ...config } as OpenAIRealtimeConfig;
    this.logger = logger.child({ component: 'OpenAIRealtime' });
  }

  // ==========================================================================
  // Connection
  // ==========================================================================

  async connect(): Promise<void> {
    if (this.isConnected) return;
    if (this.connectPromise) return this.connectPromise;

    this.emit('connectionState', 'connecting');

    const url = `wss://api.openai.com/v1/realtime?model=${this.config.model}`;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      const timeout = setTimeout(() => {
        reject(new Error('OpenAI Realtime connection timeout'));
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.isConnected = true;
        this.connectPromise = null;
        this.emit('connectionState', 'connected');
        this.logger.info('OpenAI Realtime connected');
        resolve();
      });

      this.ws.on('message', (data: Buffer | string) => {
        this.handleMessage(typeof data === 'string' ? data : data.toString('utf8'));
      });

      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        this.emit('connectionState', 'disconnected');
        this.logger.info({ code, reason: reason?.toString() }, 'OpenAI Realtime disconnected');
      });

      this.ws.on('error', (error) => {
        clearTimeout(timeout);
        this.connectPromise = null;
        this.logger.error({ error }, 'OpenAI Realtime WebSocket error');
        this.emit('error', error);
        reject(error);
      });
    });

    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.sessionId = null;
  }

  // ==========================================================================
  // Session Configuration
  // ==========================================================================

  /**
   * Configure the session — voice, instructions, tools, audio format.
   * Call after connect() and before streaming audio.
   */
  configureSession(overrides?: Partial<OpenAIRealtimeConfig>): void {
    const cfg = { ...this.config, ...overrides };

    const sessionUpdate: Record<string, unknown> = {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: cfg.instructions,
        voice: cfg.voice,
        input_audio_format: cfg.audioFormat,
        output_audio_format: cfg.audioFormat,
        turn_detection: cfg.turnDetection === 'none' ? null : {
          type: cfg.turnDetection,
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
        tools: cfg.tools.map(t => ({
          type: t.type,
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        temperature: cfg.temperature,
        max_response_output_tokens: cfg.maxResponseOutputTokens,
      },
    };

    this.send(sessionUpdate);
    this.logger.info({ voice: cfg.voice, audioFormat: cfg.audioFormat, tools: cfg.tools.length }, 'Session configured');
  }

  /**
   * Update instructions mid-session (e.g., after language detection).
   */
  updateInstructions(instructions: string): void {
    this.send({
      type: 'session.update',
      session: { instructions },
    });
  }

  // ==========================================================================
  // Audio Streaming
  // ==========================================================================

  /**
   * Stream audio from the caller to OpenAI.
   * Audio should be base64-encoded in the configured format (g711_ulaw for telephony).
   */
  sendAudio(audioBase64: string): void {
    if (!this.isConnected || !this.ws) return;

    this.send({
      type: 'input_audio_buffer.append',
      audio: audioBase64,
    });
  }

  /**
   * Stream raw audio buffer from the caller.
   * Converts to base64 automatically.
   */
  sendAudioBuffer(audio: Buffer): void {
    this.sendAudio(audio.toString('base64'));
  }

  /**
   * Manually commit the audio buffer (when VAD is disabled).
   */
  commitAudio(): void {
    this.send({ type: 'input_audio_buffer.commit' });
  }

  /**
   * Clear the audio input buffer.
   */
  clearAudioBuffer(): void {
    this.send({ type: 'input_audio_buffer.clear' });
  }

  // ==========================================================================
  // Response Control
  // ==========================================================================

  /**
   * Manually trigger a response (when VAD is disabled).
   */
  createResponse(overrides?: { instructions?: string }): void {
    const msg: Record<string, unknown> = {
      type: 'response.create',
      response: {
        modalities: ['text', 'audio'],
      },
    };
    if (overrides?.instructions) {
      (msg.response as any).instructions = overrides.instructions;
    }
    this.send(msg);
  }

  /**
   * Cancel an in-progress response (for barge-in).
   */
  cancelResponse(): void {
    this.send({ type: 'response.cancel' });
  }

  /**
   * Send function call result back to the model.
   */
  sendFunctionResult(callId: string, output: string): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output,
      },
    });
    // Trigger response after providing function output
    this.createResponse();
  }

  /**
   * Add a text message to the conversation (e.g., system context).
   */
  addTextMessage(role: 'user' | 'assistant', text: string): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role,
        content: [{ type: 'input_text', text }],
      },
    });
  }

  // ==========================================================================
  // Message Handling
  // ==========================================================================

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.logger.warn({ rawLen: raw.length }, 'Failed to parse OpenAI Realtime message');
      return;
    }

    switch (msg.type) {
      case 'session.created':
        this.sessionId = msg.session?.id;
        this.logger.info({ sessionId: this.sessionId }, 'Session created');
        this.configureSession();
        break;

      case 'session.updated':
        this.logger.info('Session updated');
        this.emit('sessionReady');
        break;

      case 'response.audio.delta':
        // Streaming audio chunk from AI
        if (msg.delta) {
          const audioBuffer = Buffer.from(msg.delta, 'base64');
          this.emit('audio', audioBuffer);
        }
        break;

      case 'response.audio_transcript.delta':
        // Streaming transcript of AI speech
        break;

      case 'response.audio_transcript.done':
        if (msg.transcript) {
          this.emit('transcript', msg.transcript);
        }
        break;

      case 'response.done':
        this.emit('responseDone');
        break;

      case 'response.function_call_arguments.done':
        this.logger.info({ name: msg.name, callId: msg.call_id }, 'Function call from AI');
        this.emit('functionCall', msg.call_id, msg.name, msg.arguments);
        break;

      case 'input_audio_buffer.speech_started':
        this.emit('speechStarted');
        break;

      case 'input_audio_buffer.speech_stopped':
        this.emit('speechStopped');
        break;

      case 'error':
        this.logger.error({ error: msg.error }, 'OpenAI Realtime error');
        this.emit('error', new Error(msg.error?.message ?? 'OpenAI Realtime error'));
        break;

      default:
        // Log unhandled event types at debug level
        this.logger.debug({ type: msg.type }, 'OpenAI Realtime event');
        break;
    }
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  private send(msg: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get session(): string | null {
    return this.sessionId;
  }
}
