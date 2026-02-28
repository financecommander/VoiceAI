/**
 * Cartesia TTS Client — Sonic-3
 *
 * Real-time text-to-speech via Cartesia's WebSocket API.
 * Streams audio chunks back as they're generated for
 * minimal time-to-first-byte.
 *
 * Voices are configured per Calculus model for brand consistency.
 *
 * Cost: ~$0.030/min
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import type { Logger } from 'pino';
import type { CalcModel } from '../types.js';

// ============================================================================
// Configuration
// ============================================================================

export interface CartesiaConfig {
  apiKey: string;
  endpoint: string;
  /** Voice ID per Calculus model */
  voices: Record<string, string>;
  /** Output format */
  outputFormat: {
    container: 'raw';
    encoding: 'pcm_s16le';
    sampleRate: number;
  };
  /** Speed factor (1.0 = normal) */
  speed: number;
}

export const DEFAULT_CARTESIA_CONFIG: Partial<CartesiaConfig> = {
  endpoint: 'wss://api.cartesia.ai/tts/websocket',
  outputFormat: {
    container: 'raw',
    encoding: 'pcm_s16le',
    sampleRate: 16000,
  },
  speed: 1.0,
};

// ============================================================================
// Cartesia TTS Client
// ============================================================================

export class CartesiaTTSClient extends EventEmitter {
  private config: CartesiaConfig;
  private ws: WebSocket | null = null;
  private logger: Logger;
  private isConnected = false;
  private activeContextId: string | null = null;
  private activeModel: CalcModel = 'DMC' as CalcModel;

  constructor(config: CartesiaConfig, logger: Logger) {
    super();
    this.config = { ...DEFAULT_CARTESIA_CONFIG, ...config } as CartesiaConfig;
    this.logger = logger.child({ component: 'CartesiaTTS' });
  }

  // ==========================================================================
  // Connection
  // ==========================================================================

  async connect(): Promise<void> {
    if (this.isConnected) return;

    const url = `${this.config.endpoint}?api_key=${this.config.apiKey}&cartesia_version=2024-06-10`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        reject(new Error('Cartesia connection timeout'));
      }, 5000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.isConnected = true;
        this.logger.info('Cartesia TTS connected');
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        this.logger.info('Cartesia TTS disconnected');
      });

      this.ws.on('error', (error) => {
        clearTimeout(timeout);
        this.logger.error({ error }, 'Cartesia WebSocket error');
        this.emit('error', error);
        reject(error);
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }

  // ==========================================================================
  // TTS Synthesis
  // ==========================================================================

  /**
   * Synthesize text to speech. Audio chunks are emitted via 'audio' event.
   * 'done' event fires when synthesis is complete.
   */
  async synthesize(text: string): Promise<void> {
    if (!this.isConnected || !this.ws) {
      await this.connect();
    }

    this.activeContextId = uuid();
    const voiceId = this.config.voices[this.activeModel] ?? Object.values(this.config.voices)[0];

    const message = {
      model_id: 'sonic-3',
      transcript: text,
      voice: {
        mode: 'id',
        id: voiceId,
      },
      output_format: this.config.outputFormat,
      context_id: this.activeContextId,
      language: 'en',
      add_timestamps: false,
    };

    this.ws!.send(JSON.stringify(message));
  }

  /**
   * Cancel any in-flight synthesis (for barge-in).
   */
  cancel(): void {
    if (!this.ws || !this.isConnected || !this.activeContextId) return;

    this.ws.send(JSON.stringify({
      context_id: this.activeContextId,
      cancel: true,
    }));

    this.activeContextId = null;
    this.emit('cancelled');
  }

  /**
   * Set the active model (changes voice).
   */
  setModel(model: CalcModel): void {
    this.activeModel = model;
  }

  // ==========================================================================
  // Message Handling
  // ==========================================================================

  private handleMessage(raw: Buffer): void {
    // Cartesia sends binary audio frames and JSON control messages
    // Binary frames = audio data
    // JSON frames = status/done/error

    // Try JSON first
    try {
      const text = raw.toString();
      if (text.startsWith('{')) {
        const msg = JSON.parse(text);

        if (msg.type === 'done' || msg.done === true) {
          this.emit('done');
          return;
        }

        if (msg.type === 'error') {
          this.logger.error({ error: msg }, 'Cartesia synthesis error');
          this.emit('error', new Error(msg.message ?? 'Cartesia error'));
          return;
        }

        // Audio data in JSON response (base64)
        if (msg.data) {
          const audioBuffer = Buffer.from(msg.data, 'base64');
          this.emit('audio', audioBuffer);
          return;
        }

        return;
      }
    } catch {
      // Not JSON — treat as raw audio
    }

    // Binary audio frame
    this.emit('audio', raw);
  }

  get connected(): boolean {
    return this.isConnected;
  }
}
