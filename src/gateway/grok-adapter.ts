/**
 * Grok Voice Agent API — WebSocket Adapter
 *
 * Connects to xAI's realtime speech-to-speech endpoint.
 * Compatible with OpenAI Realtime API spec (as documented by xAI).
 *
 * Architecture:
 *   Telephony (Twilio/Telnyx) → WebSocket → Grok Realtime → WebSocket → Telephony
 *
 * This adapter handles:
 *   - WebSocket connection lifecycle
 *   - Audio stream bridging (telephony ↔ Grok)
 *   - Tool call execution (read-only tools only)
 *   - Session configuration (voice, system prompt, tools)
 *   - Safety monitoring (keyword detection on Grok's text output)
 *   - Fallback to modular pipeline on error
 *
 * IMPORTANT: In speech-to-speech mode, ComplianceEnforcer real-time gates
 * do NOT run. Only post-call audit applies. This adapter is ONLY used
 * for Grok-eligible intents (informational, read-only queries).
 */

import WebSocket from 'ws';
import { v4 as uuid } from 'uuid';
import type { Logger } from 'pino';
import type { GrokVoiceConfig, GrokTool } from '../orchestrator/orchestrator.js';

// ============================================================================
// Configuration
// ============================================================================

export interface GrokAdapterConfig {
  /** xAI API key */
  apiKey: string;

  /** WebSocket endpoint */
  endpoint: string;

  /** Default model */
  model: string;

  /** Connection timeout ms */
  connectionTimeoutMs: number;

  /** Max session duration ms (safety cutoff) */
  maxSessionDurationMs: number;

  /** Enable transcript capture for post-call audit */
  captureTranscript: boolean;

  /** Safety keywords that trigger immediate disconnect + fallback */
  safetyKeywords: string[];
}

export const DEFAULT_GROK_CONFIG: GrokAdapterConfig = {
  apiKey: process.env.XAI_API_KEY ?? '',
  endpoint: 'wss://api.x.ai/v1/realtime',
  model: 'grok-3-fast',
  connectionTimeoutMs: 5000,
  maxSessionDurationMs: 30 * 60 * 1000, // 30 min max
  captureTranscript: true,
  safetyKeywords: [
    'you should buy', 'you should sell', 'i recommend',
    'guaranteed return', 'now is a good time',
    'this is a safe investment', 'you should invest',
  ],
};

// ============================================================================
// Events emitted by the adapter
// ============================================================================

export type GrokAdapterEvent =
  | { type: 'connected'; sessionId: string }
  | { type: 'audio_out'; audio: Buffer; format: string }
  | { type: 'transcript_agent'; text: string; isFinal: boolean }
  | { type: 'transcript_user'; text: string; isFinal: boolean }
  | { type: 'tool_call'; toolName: string; args: Record<string, unknown>; callId: string }
  | { type: 'turn_complete' }
  | { type: 'safety_trigger'; keyword: string; fullText: string }
  | { type: 'error'; error: Error; recoverable: boolean }
  | { type: 'disconnected'; reason: string };

export type GrokEventHandler = (event: GrokAdapterEvent) => void;

// ============================================================================
// Grok Voice Adapter
// ============================================================================

export class GrokVoiceAdapter {
  private config: GrokAdapterConfig;
  private logger: Logger;
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private eventHandler: GrokEventHandler;
  private transcript: TranscriptEntry[] = [];
  private connectionTimer: NodeJS.Timeout | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  private isConnected = false;

  constructor(
    config: GrokAdapterConfig,
    eventHandler: GrokEventHandler,
    logger: Logger,
  ) {
    this.config = config;
    this.eventHandler = eventHandler;
    this.logger = logger.child({ component: 'GrokVoiceAdapter' });
  }

  // ==========================================================================
  // Connection Lifecycle
  // ==========================================================================

  /**
   * Connect to Grok Voice Agent API and configure session.
   */
  async connect(voiceConfig: GrokVoiceConfig): Promise<void> {
    if (this.isConnected) {
      this.logger.warn('Already connected, disconnecting first');
      await this.disconnect('reconnect');
    }

    this.sessionId = uuid();
    this.transcript = [];

    return new Promise((resolve, reject) => {
      const url = `${this.config.endpoint}?model=${voiceConfig.model}`;

      this.ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      // Connection timeout
      this.connectionTimer = setTimeout(() => {
        if (!this.isConnected) {
          this.logger.error('Connection timeout');
          this.ws?.close();
          reject(new Error('Grok connection timeout'));
        }
      }, this.config.connectionTimeoutMs);

      // Session max duration timer
      this.sessionTimer = setTimeout(() => {
        this.logger.warn('Max session duration reached');
        this.disconnect('max_duration');
      }, this.config.maxSessionDurationMs);

      this.ws.on('open', () => {
        this.isConnected = true;
        if (this.connectionTimer) clearTimeout(this.connectionTimer);
        this.logger.info({ sessionId: this.sessionId }, 'Connected to Grok Voice');

        // Configure session
        this.sendSessionConfig(voiceConfig);
        this.eventHandler({ type: 'connected', sessionId: this.sessionId! });
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error: Error) => {
        this.logger.error({ error }, 'WebSocket error');
        this.eventHandler({
          type: 'error',
          error,
          recoverable: true, // Caller should fallback to modular pipeline
        });
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        this.isConnected = false;
        const reasonStr = reason.toString() || `code ${code}`;
        this.logger.info({ code, reason: reasonStr }, 'Disconnected from Grok');
        this.eventHandler({ type: 'disconnected', reason: reasonStr });
        this.cleanup();
      });
    });
  }

  /**
   * Send session configuration to Grok (system prompt, voice, tools).
   * Uses OpenAI Realtime-compatible event format.
   */
  private sendSessionConfig(voiceConfig: GrokVoiceConfig): void {
    this.send({
      type: 'session.update',
      session: {
        modalities: voiceConfig.modalities,
        instructions: voiceConfig.systemPrompt,
        voice: voiceConfig.voice.toLowerCase(),
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1',  // Grok uses Whisper for input transcription
        },
        turn_detection: {
          type: 'server_vad',   // Grok handles voice activity detection
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
        tools: voiceConfig.tools.map(t => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: {
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(t.parameters).map(([k, v]) => [k, { type: v }])
            ),
          },
        })),
        temperature: voiceConfig.temperature,
      },
    });
  }

  // ==========================================================================
  // Audio Streaming
  // ==========================================================================

  /**
   * Stream audio from telephony to Grok.
   * Call this for every audio chunk from Twilio/Telnyx.
   */
  sendAudio(audioChunk: Buffer): void {
    if (!this.isConnected || !this.ws) return;

    this.send({
      type: 'input_audio_buffer.append',
      audio: audioChunk.toString('base64'),
    });
  }

  /**
   * Signal that the user has finished speaking (manual VAD override).
   */
  commitAudioBuffer(): void {
    this.send({ type: 'input_audio_buffer.commit' });
  }

  /**
   * Interrupt Grok's response (user started speaking).
   */
  cancelResponse(): void {
    this.send({ type: 'response.cancel' });
  }

  // ==========================================================================
  // Tool Call Handling
  // ==========================================================================

  /**
   * Send tool result back to Grok after executing a function call.
   */
  sendToolResult(callId: string, result: unknown): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(result),
      },
    });

    // Trigger Grok to generate response with tool result
    this.send({ type: 'response.create' });
  }

  // ==========================================================================
  // Message Handling
  // ==========================================================================

  private handleMessage(raw: Buffer): void {
    let event: any;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      this.logger.warn('Failed to parse Grok message');
      return;
    }

    switch (event.type) {
      // Audio output from Grok → send to telephony
      case 'response.audio.delta':
        if (event.delta) {
          const audioBuffer = Buffer.from(event.delta, 'base64');
          this.eventHandler({ type: 'audio_out', audio: audioBuffer, format: 'pcm16' });
        }
        break;

      // Agent text transcript (for logging and safety monitoring)
      case 'response.audio_transcript.delta':
        if (event.delta) {
          // Safety check — scan Grok's output for prohibited content
          this.checkSafety(event.delta);

          this.eventHandler({
            type: 'transcript_agent',
            text: event.delta,
            isFinal: false,
          });
        }
        break;

      case 'response.audio_transcript.done':
        if (event.transcript) {
          this.checkSafety(event.transcript);

          if (this.config.captureTranscript) {
            this.transcript.push({
              speaker: 'agent',
              text: event.transcript,
              timestamp: new Date(),
            });
          }

          this.eventHandler({
            type: 'transcript_agent',
            text: event.transcript,
            isFinal: true,
          });
        }
        break;

      // User transcript (from Grok's built-in STT)
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          if (this.config.captureTranscript) {
            this.transcript.push({
              speaker: 'user',
              text: event.transcript,
              timestamp: new Date(),
            });
          }

          this.eventHandler({
            type: 'transcript_user',
            text: event.transcript,
            isFinal: true,
          });
        }
        break;

      // Tool call from Grok
      case 'response.function_call_arguments.done':
        this.logger.info({
          tool: event.name,
          callId: event.call_id,
        }, 'Grok tool call');

        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(event.arguments || '{}');
        } catch {
          this.logger.warn('Failed to parse tool arguments');
        }

        this.eventHandler({
          type: 'tool_call',
          toolName: event.name,
          args,
          callId: event.call_id,
        });
        break;

      // Response complete
      case 'response.done':
        this.eventHandler({ type: 'turn_complete' });
        break;

      // Error from Grok
      case 'error':
        this.logger.error({ grokError: event.error }, 'Grok error event');
        this.eventHandler({
          type: 'error',
          error: new Error(event.error?.message ?? 'Unknown Grok error'),
          recoverable: true,
        });
        break;

      default:
        // Ignore other events (rate_limits, session.created, etc.)
        break;
    }
  }

  // ==========================================================================
  // Safety Monitoring
  // ==========================================================================

  /**
   * Scan Grok's output for prohibited content.
   * Since we can't intercept speech-to-speech before it reaches the caller,
   * we monitor the transcript and flag violations for post-call audit.
   * On critical safety keywords, we disconnect immediately.
   */
  private checkSafety(text: string): void {
    const lower = text.toLowerCase();

    for (const keyword of this.config.safetyKeywords) {
      if (lower.includes(keyword)) {
        this.logger.error({
          keyword,
          text: text.substring(0, 200),
        }, 'SAFETY TRIGGER: Grok generated prohibited content');

        this.eventHandler({
          type: 'safety_trigger',
          keyword,
          fullText: text,
        });

        // For critical financial compliance violations, disconnect immediately
        // The pipeline controller will fallback to modular pipeline
        if (this.isCriticalViolation(keyword)) {
          this.disconnect('safety_violation');
        }
        return;
      }
    }
  }

  private isCriticalViolation(keyword: string): boolean {
    const critical = [
      'you should buy', 'you should sell', 'guaranteed return',
      'this is a safe investment', 'you should invest',
    ];
    return critical.includes(keyword);
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  private send(event: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn('Cannot send — WebSocket not open');
      return;
    }
    this.ws.send(JSON.stringify(event));
  }

  async disconnect(reason: string): Promise<void> {
    this.logger.info({ reason }, 'Disconnecting from Grok');
    this.cleanup();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, reason);
    }
    this.ws = null;
    this.isConnected = false;
  }

  private cleanup(): void {
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.connectionTimer = null;
    this.sessionTimer = null;
  }

  /** Get captured transcript for post-call audit */
  getTranscript(): TranscriptEntry[] {
    return [...this.transcript];
  }

  /** Get session ID */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Is currently connected */
  get connected(): boolean {
    return this.isConnected;
  }
}

// ============================================================================
// Types
// ============================================================================

interface TranscriptEntry {
  speaker: 'user' | 'agent';
  text: string;
  timestamp: Date;
}
