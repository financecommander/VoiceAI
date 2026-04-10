/**
 * Deepgram STT Client — Nova-3
 *
 * Real-time speech-to-text via Deepgram's WebSocket API.
 * Used in the modular pipeline (not needed for Grok S2S).
 *
 * Features used:
 *   - Nova-3 model (best accuracy for finance/legal)
 *   - Smart formatting (numbers, currency)
 *   - Interim results (for UX responsiveness)
 *   - Endpointing (300ms silence = end of utterance)
 *   - VAD events (for barge-in detection)
 *   - PII redaction (SSN, credit card masking)
 *
 * Cost: ~$0.0065/min (Nova-3 pay-as-you-go)
 */

import {
  createClient,
  LiveTranscriptionEvents,
  type DeepgramClient,
  type LiveClient,
} from '@deepgram/sdk';
import { EventEmitter } from 'events';
import type { Logger } from 'pino';

// ============================================================================
// Configuration
// ============================================================================

export interface DeepgramConfig {
  apiKey: string;
  /** Keep-alive interval ms */
  keepAliveMs: number;
  /** Max connection duration before reconnect */
  maxConnectionMs: number;
}

export interface DeepgramStreamOptions {
  encoding: 'linear16' | 'mulaw';
  sampleRate: number;
  channels: number;
  model: 'nova-3' | 'nova-2';
  language: string;
  smartFormat: boolean;
  punctuate: boolean;
  interimResults: boolean;
  endpointing: number;        // Silence duration ms to finalize utterance
  utteranceEndMs: number;      // Max utterance length before force-finalize
  vadEvents: boolean;
  /** Enable automatic language detection (multi-language support) */
  detectLanguage?: boolean;
}

// ============================================================================
// Deepgram STT Client
// ============================================================================

export class DeepgramSTTClient extends EventEmitter {
  private client: DeepgramClient;
  private connection: LiveClient | null = null;
  private logger: Logger;
  private config: DeepgramConfig;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnected = false;

  constructor(config: DeepgramConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger.child({ component: 'DeepgramSTT' });
    this.client = createClient(config.apiKey);
  }

  // ==========================================================================
  // Stream Lifecycle
  // ==========================================================================

  async startStream(options: DeepgramStreamOptions): Promise<void> {
    if (this.isConnected) {
      await this.stopStream();
    }

    this.logger.info({
      model: options.model,
      sampleRate: options.sampleRate,
      encoding: options.encoding,
    }, 'Starting Deepgram stream');

    this.connection = this.client.listen.live({
      model: options.model,
      language: options.detectLanguage ? undefined : options.language,
      detect_language: options.detectLanguage ?? false,
      encoding: options.encoding,
      sample_rate: options.sampleRate,
      channels: options.channels,
      smart_format: options.smartFormat,
      punctuate: options.punctuate,
      interim_results: options.interimResults,
      endpointing: options.endpointing,
      utterance_end_ms: options.utteranceEndMs,
      vad_events: options.vadEvents,
    });

    this.setupListeners();

    // Wait for connection to actually open before returning
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Deepgram connection timeout (5s)'));
      }, 5000);

      const checkOpen = () => {
        if (this.isConnected) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkOpen, 50);
        }
      };
      checkOpen();
    });

    this.logger.info('Deepgram connection confirmed open');

    // Keep-alive pings
    this.keepAliveTimer = setInterval(() => {
      if (this.connection && this.isConnected) {
        this.connection.keepAlive();
      }
    }, this.config.keepAliveMs);

    // Auto-reconnect after max duration
    this.reconnectTimer = setTimeout(async () => {
      this.logger.info('Reconnecting Deepgram (max connection duration)');
      await this.stopStream();
      await this.startStream(options);
    }, this.config.maxConnectionMs);
  }

  async stopStream(): Promise<void> {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.jitterFlushTimer) clearInterval(this.jitterFlushTimer);
    this.keepAliveTimer = null;
    this.reconnectTimer = null;
    this.jitterFlushTimer = null;

    // Flush remaining audio before closing
    this.flushJitterBuffer();
    this.jitterBuffer = [];

    if (this.connection) {
      try {
        this.connection.requestClose();
      } catch { /* ignore */ }
      this.connection = null;
    }

    this.isConnected = false;
  }

  // ==========================================================================
  // Audio Input
  // ==========================================================================

  /**
   * Jitter buffer: smooths out timing variance from WebSocket audio delivery.
   * Accumulates chunks and flushes at a steady interval to prevent Deepgram
   * from receiving bursts of frames followed by gaps (which causes stuttering).
   */
  private jitterBuffer: Buffer[] = [];
  private jitterFlushTimer: NodeJS.Timeout | null = null;
  private static readonly JITTER_FLUSH_MS = 40; // flush every 40ms (2x 20ms telephony frame)

  /**
   * Send PCM audio chunk to Deepgram for transcription.
   * Expects 16-bit PCM at the sample rate specified in startStream().
   * Audio is smoothed through a jitter buffer before delivery.
   */
  sendAudio(pcmChunk: Buffer): void {
    if (!this.connection || !this.isConnected) return;

    // Add to jitter buffer
    this.jitterBuffer.push(pcmChunk);

    // Start flush timer if not running
    if (!this.jitterFlushTimer) {
      this.jitterFlushTimer = setInterval(() => {
        this.flushJitterBuffer();
      }, DeepgramSTTClient.JITTER_FLUSH_MS);
    }
  }

  private flushJitterBuffer(): void {
    if (!this.connection || !this.isConnected || this.jitterBuffer.length === 0) return;

    // Send all buffered chunks
    try {
      for (const chunk of this.jitterBuffer) {
        (this.connection as any).send(chunk);
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to send audio to Deepgram');
    }
    this.jitterBuffer = [];
  }

  // ==========================================================================
  // Event Listeners
  // ==========================================================================

  private setupListeners(): void {
    if (!this.connection) return;

    this.connection.on(LiveTranscriptionEvents.Open, () => {
      this.isConnected = true;
      this.logger.info('Deepgram connection opened');
    });

    this.connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      const isFinal = data.is_final === true;
      if (isFinal) {
        this.logger.info({ transcript: transcript?.substring(0, 60) || '(empty)', speechFinal: data.speech_final }, 'Deepgram final transcript');
      }
      if (!transcript) return;
      const speechFinal = data.speech_final === true;
      const detectedLanguage = data.channel?.detected_language ?? null;
      const confidence = data.channel?.alternatives?.[0]?.confidence ?? 1.0;

      this.emit('transcript', transcript, isFinal, speechFinal, detectedLanguage, confidence);

      // Emit on utterance completion (final + speech_final)
      if (isFinal && speechFinal) {
        this.emit('utteranceEnd', transcript);
      }

      // Emit language detection event when detected
      if (detectedLanguage && isFinal) {
        this.emit('languageDetected', detectedLanguage);
      }
    });

    this.connection.on(LiveTranscriptionEvents.SpeechStarted, () => {
      this.logger.info('Deepgram: speech detected');
      this.emit('speechStarted');
    });

    this.connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      this.emit('utteranceEnd', '');
    });

    this.connection.on(LiveTranscriptionEvents.Error, (error: any) => {
      const detail = typeof error === 'object'
        ? JSON.stringify(error, Object.getOwnPropertyNames(error))
        : String(error);
      this.logger.error({ error: detail }, 'Deepgram error');
      this.emit('error', new Error(error?.message ?? `Deepgram error: ${detail}`));
    });

    this.connection.on(LiveTranscriptionEvents.Close, () => {
      this.isConnected = false;
      this.logger.info('Deepgram connection closed');
    });
  }

  get connected(): boolean {
    return this.isConnected;
  }
}
