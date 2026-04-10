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
  /** Language-specific voice overrides — native speakers for best accent */
  languageVoices?: Record<string, string>;
  /** Output format — pcm_mulaw for zero-conversion Twilio pipeline */
  outputFormat: {
    container: 'raw';
    encoding: 'pcm_mulaw' | 'pcm_s16le';
    sampleRate: number;
  };
  /** Speed factor (1.0 = normal) */
  speed: number;
}

/** Native-speaker voices for each language — best accent quality */
export const LANGUAGE_VOICES: Record<string, string> = {
  fr: '5def377d-908b-4540-8bd7-3c968fcae351',  // Benoît — French Parisian male
  nl: 'da743a82-ddf2-4d9b-8eb8-ff67ca0b138e',  // Stijn — Dutch male
  it: 'a0e99841-438c-4a64-b679-ae501e7d6091',  // fallback to default
  es: 'a0e99841-438c-4a64-b679-ae501e7d6091',  // fallback to default
  de: 'a0e99841-438c-4a64-b679-ae501e7d6091',  // fallback to default
};

export const DEFAULT_CARTESIA_CONFIG: Partial<CartesiaConfig> = {
  endpoint: 'wss://api.cartesia.ai/tts/websocket',
  outputFormat: {
    container: 'raw',
    encoding: 'pcm_mulaw',    // Native mulaw — zero conversion to Twilio
    sampleRate: 8000,          // Match Twilio's native 8kHz
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
  private connectPromise: Promise<void> | null = null;
  private activeContextId: string | null = null;
  private activeModel: CalcModel = 'DMC' as CalcModel;

  constructor(config: CartesiaConfig, logger: Logger) {
    super();
    this.config = {
      ...DEFAULT_CARTESIA_CONFIG,
      ...config,
      languageVoices: { ...LANGUAGE_VOICES, ...config.languageVoices },
    } as CartesiaConfig;
    this.logger = logger.child({ component: 'CartesiaTTS' });
  }

  // ==========================================================================
  // Connection
  // ==========================================================================

  async connect(): Promise<void> {
    if (this.isConnected) return;
    if (this.connectPromise) return this.connectPromise;

    const url = `${this.config.endpoint}?api_key=${this.config.apiKey}&cartesia_version=2024-06-10`;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        reject(new Error('Cartesia connection timeout'));
      }, 5000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.isConnected = true;
        this.connectPromise = null;
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
        this.connectPromise = null;
        this.logger.error({ error }, 'Cartesia WebSocket error');
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
  }

  // ==========================================================================
  // TTS Synthesis
  // ==========================================================================

  /** Active language for TTS — auto-detected or explicitly set */
  private activeLanguage: string = 'en';

  /**
   * Set the language for TTS synthesis (e.g., 'fr', 'nl', 'it', 'en').
   * Cartesia uses this for proper pronunciation and accent.
   */
  setLanguage(lang: string): void {
    this.activeLanguage = lang;
    this.logger.info({ language: lang }, 'Cartesia language set');
  }

  /**
   * Auto-detect language from text content.
   * Simple heuristic for common patterns.
   */
  private detectLanguageFromText(text: string): string {
    const lower = text.toLowerCase();
    // French indicators
    if (/\b(bonjour|salut|comment|merci|oui|je suis|petit|agneau|avait|avec|très|être|avoir|dans|mais|pour|vous|nous|c'est|qu[ei])\b/.test(lower)) return 'fr';
    // Dutch indicators
    if (/\b(hoe gaat|moeder|vader|goed|dank|alsjeblieft|welkom|hallo|bedankt|ja|nee|goedendag|vandaag)\b/.test(lower)) return 'nl';
    // Italian indicators
    if (/\b(ciao|buongiorno|grazie|come stai|bene|padre|madre|molto|sono|perch[eé]|questo|quello|buona)\b/.test(lower)) return 'it';
    // Spanish indicators
    if (/\b(hola|gracias|cómo|buenos|buenas|señor|señora|padre|madre|muy|está|tiene)\b/.test(lower)) return 'es';
    // German indicators
    if (/\b(guten|danke|wie geht|mutter|vater|sehr|bitte|ja|nein|heute|morgen)\b/.test(lower)) return 'de';
    return this.activeLanguage;
  }

  /**
   * Resolve the best voice ID for a given language.
   * Uses native-speaker voices for non-English languages (e.g., Benoît for French).
   */
  private resolveVoice(lang: string): string {
    // Use language-specific native voice for non-English
    if (lang !== 'en' && this.config.languageVoices?.[lang]) {
      return this.config.languageVoices[lang];
    }
    // Default: model-specific voice (guard against empty string from missing env vars)
    const modelVoice = this.config.voices[this.activeModel];
    if (modelVoice) return modelVoice;
    // Fallback to first non-empty voice
    const fallback = Object.values(this.config.voices).find(v => v);
    if (!fallback) {
      this.logger.error({ model: this.activeModel }, 'No voice ID configured — TTS will fail');
    }
    return fallback ?? '';
  }

  /**
   * Synthesize text to speech. Audio chunks are emitted via 'audio' event.
   * 'done' event fires when synthesis is complete.
   */
  async synthesize(text: string, language?: string): Promise<void> {
    if (!this.isConnected || !this.ws) {
      await this.connect();
    }

    this.activeContextId = uuid();

    // Detect language from text if not explicitly provided
    const lang = language ?? this.detectLanguageFromText(text);
    const voiceId = this.resolveVoice(lang);

    const message = {
      model_id: 'sonic-3',
      transcript: text,
      voice: {
        mode: 'id',
        id: voiceId,
      },
      output_format: {
        container: this.config.outputFormat.container,
        encoding: this.config.outputFormat.encoding,
        sample_rate: this.config.outputFormat.sampleRate,
      },
      context_id: this.activeContextId,
      language: lang,
      add_timestamps: false,
    };

    if (!voiceId) {
      this.logger.error({ model: this.activeModel, language: lang }, 'No voice ID — cannot synthesize');
      this.emit('error', new Error(`No voice ID for model ${this.activeModel}`));
      return;
    }

    this.logger.info({ voiceId, model: this.activeModel, textLen: text.length, language: lang }, 'Sending TTS request to Cartesia');
    this.ws!.send(JSON.stringify(message));
  }

  // ==========================================================================
  // Streaming TTS — sentence-by-sentence for lower latency
  // ==========================================================================

  /**
   * Start a streaming TTS context. Call streamText() to feed text chunks,
   * then endStream() when done. Audio begins playing from the first chunk.
   */
  async startStream(language?: string): Promise<void> {
    if (!this.isConnected || !this.ws) {
      await this.connect();
    }
    this.activeContextId = uuid();
    this.streamLanguage = language ?? this.activeLanguage;
    this.streamStarted = false;
    this.logger.info({ contextId: this.activeContextId, language: this.streamLanguage }, 'Cartesia streaming context started');
  }

  private streamLanguage: string = 'en';
  private streamStarted: boolean = false;

  /**
   * Send a text chunk to the active streaming context.
   * Cartesia begins synthesizing immediately on first chunk.
   */
  streamText(text: string): void {
    if (!this.ws || !this.isConnected || !this.activeContextId) return;
    if (!text.trim()) return;

    const lang = this.detectLanguageFromText(text);
    const voiceId = this.resolveVoice(lang);

    if (!this.streamStarted) {
      // First chunk — include full config with native-speaker voice
      this.streamStarted = true;
      this.ws.send(JSON.stringify({
        model_id: 'sonic-3',
        transcript: text,
        voice: { mode: 'id', id: voiceId },
        output_format: {
          container: this.config.outputFormat.container,
          encoding: this.config.outputFormat.encoding,
          sample_rate: this.config.outputFormat.sampleRate,
        },
        context_id: this.activeContextId,
        language: lang,
        continue: true,
        add_timestamps: false,
      }));
    } else {
      // Continuation — just text + context
      this.ws.send(JSON.stringify({
        transcript: text,
        context_id: this.activeContextId,
        continue: true,
      }));
    }
  }

  /**
   * End the streaming context (final chunk).
   * Cartesia synthesizes any remaining buffered text and closes the context.
   */
  endStream(finalText?: string): void {
    if (!this.ws || !this.isConnected || !this.activeContextId) return;

    if (!this.streamStarted && finalText?.trim()) {
      const lang = this.detectLanguageFromText(finalText);
      const voiceId = this.resolveVoice(lang);
      // Only chunk — include full config, continue: false
      this.ws.send(JSON.stringify({
        model_id: 'sonic-3',
        transcript: finalText,
        voice: { mode: 'id', id: voiceId },
        output_format: {
          container: this.config.outputFormat.container,
          encoding: this.config.outputFormat.encoding,
          sample_rate: this.config.outputFormat.sampleRate,
        },
        context_id: this.activeContextId,
        language: this.detectLanguageFromText(finalText),
        continue: false,
        add_timestamps: false,
      }));
    } else {
      // Close the context with optional final text
      this.ws.send(JSON.stringify({
        transcript: finalText?.trim() || '',
        context_id: this.activeContextId,
        continue: false,
      }));
    }

    this.logger.info({ contextId: this.activeContextId }, 'Cartesia streaming context ended');
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
    this.streamStarted = false;
    this.emit('cancelled');
  }

  /** Reset context ID so next synthesize() starts fresh */
  resetContext(): void {
    this.activeContextId = null;
    this.streamStarted = false;
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

  private handleMessage(raw: Buffer | ArrayBuffer | Buffer[]): void {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);

    try {
      const text = buf.toString('utf8');
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

      // Audio data in JSON response (base64-encoded mulaw bytes)
      if (msg.data) {
        const audioBuffer = Buffer.from(msg.data, 'base64');
        this.emit('audio', audioBuffer);
        return;
      }

      // Other JSON message types (timestamps, etc.) — ignore silently
      this.logger.debug({ type: msg.type, keys: Object.keys(msg) }, 'Cartesia message (non-audio)');
    } catch {
      // Failed to parse as JSON — log and discard
      // NEVER emit unparseable data as audio (was causing distortion)
      this.logger.warn({ byteLen: buf.length, first4: buf.subarray(0, 4).toString('hex') }, 'Cartesia: discarding non-JSON message');
    }
  }

  get connected(): boolean {
    return this.isConnected;
  }
}
