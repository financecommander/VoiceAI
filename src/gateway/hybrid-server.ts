/**
 * Hybrid Voice Server — Twilio + Telnyx + OpenAI Realtime + Cartesia
 *
 * Supports three voice pipelines:
 *
 *   1. REALTIME (lowest latency ~500ms):
 *      Telnyx/Twilio → OpenAI Realtime API (voice-in, voice-out) → Telnyx/Twilio
 *      Zero-conversion: G.711 mulaw throughout
 *
 *   2. MODULAR (branded voices ~1.5s):
 *      Telnyx/Twilio → Deepgram STT → GPT-4o → Cartesia TTS → Telnyx/Twilio
 *      Zero-conversion: mulaw from Cartesia direct to telephony
 *
 *   3. HYBRID (best of both):
 *      Use Realtime for fast conversational turns
 *      Switch to Modular for branded-voice responses
 *
 * Endpoints:
 *   POST /webhook/telnyx/inbound     — Telnyx inbound (TeXML)
 *   POST /webhook/telnyx/outbound    — Telnyx outbound (TeXML)
 *   POST /webhook/twilio/inbound     — Twilio inbound (TwiML)
 *   POST /webhook/twilio/outbound    — Twilio outbound (TwiML)
 *   WS   /ws/telnyx/:callId          — Telnyx media stream
 *   WS   /ws/call/:callSid           — Twilio media stream
 *   POST /api/outbound/trigger       — Queue outbound call
 *   GET  /health                     — Health check
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import pino from 'pino';
import dotenv from 'dotenv';
import { URL } from 'url';

import { OpenAIRealtimeClient } from './openai-realtime-client.js';
import { TelnyxMediaStreamHandler } from './telnyx-stream.js';
import { DeepgramSTTClient } from './deepgram-client.js';
import { CartesiaTTSClient } from './cartesia-client.js';
import type { VoicePipelineMode } from './telnyx-stream.js';

dotenv.config();

// ============================================================================
// Logger
// ============================================================================

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty' }
    : undefined,
});

// ============================================================================
// Express App
// ============================================================================

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Default pipeline mode
const defaultPipeline: VoicePipelineMode =
  (process.env.VOICE_PIPELINE_MODE as VoicePipelineMode) ?? 'realtime';

// ============================================================================
// Health Check
// ============================================================================

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    uptime: process.uptime(),
    pipelines: {
      realtime: !!process.env.OPENAI_API_KEY,
      modular: !!(process.env.DEEPGRAM_API_KEY && process.env.CARTESIA_API_KEY),
      defaultMode: defaultPipeline,
    },
    providers: {
      telnyx: !!process.env.TELNYX_API_KEY,
      twilio: !!process.env.TWILIO_ACCOUNT_SID,
    },
  });
});

// ============================================================================
// Telnyx Inbound Webhook (TeXML)
// ============================================================================

app.post('/webhook/telnyx/inbound', (req, res) => {
  const { From, To, CallControlId } = req.body;
  logger.info({ from: From, to: To, callControlId: CallControlId }, 'Telnyx inbound call');

  const wsHost = process.env.WS_HOST || req.headers.host || 'localhost:3000';
  const wsProtocol = process.env.WS_PROTOCOL || 'wss';
  const pipeline = req.query.pipeline || defaultPipeline;

  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${wsProtocol}://${wsHost}/ws/telnyx/${CallControlId}"
            track="both_tracks"
            codec="PCMU"
            bidirectionalMode="rtp"
            bidirectionalCodec="PCMU"
            bidirectionalSamplingRate="8000">
      <Parameter name="direction" value="inbound" />
      <Parameter name="callerPhone" value="${From}" />
      <Parameter name="calledPhone" value="${To}" />
      <Parameter name="pipelineMode" value="${pipeline}" />
    </Stream>
  </Start>
  <Pause length="3600" />
</Response>`);
});

// ============================================================================
// Telnyx Outbound Webhook
// ============================================================================

app.post('/webhook/telnyx/outbound', (req, res) => {
  const { From, To, CallControlId } = req.body;
  const agent = req.query.agent as string || 'JACK';
  const recipientName = req.query.recipientName as string || '';
  const message = req.query.message as string || '';
  const pipeline = req.query.pipeline as string || defaultPipeline;

  logger.info({ from: From, to: To, agent, pipeline }, 'Telnyx outbound call connected');

  const wsHost = process.env.WS_HOST || req.headers.host || 'localhost:3000';
  const wsProtocol = process.env.WS_PROTOCOL || 'wss';

  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${wsProtocol}://${wsHost}/ws/telnyx/${CallControlId}"
            track="both_tracks"
            codec="PCMU"
            bidirectionalMode="rtp"
            bidirectionalCodec="PCMU"
            bidirectionalSamplingRate="8000">
      <Parameter name="model" value="${agent}" />
      <Parameter name="direction" value="outbound" />
      <Parameter name="callerPhone" value="${From}" />
      <Parameter name="calledPhone" value="${To}" />
      <Parameter name="recipientName" value="${recipientName}" />
      <Parameter name="instructions" value="${message}" />
      <Parameter name="pipelineMode" value="${pipeline}" />
    </Stream>
  </Start>
  <Pause length="3600" />
</Response>`);
});

// ============================================================================
// Outbound Call Trigger API
// ============================================================================

app.post('/api/outbound/trigger', async (req, res) => {
  const { recipientPhone, recipientName, agent, message, pipeline, provider } = req.body;

  if (!recipientPhone) {
    res.status(400).json({ error: 'recipientPhone required' });
    return;
  }

  const callProvider = provider ?? (process.env.TELNYX_API_KEY ? 'telnyx' : 'twilio');

  logger.info({ recipientPhone, agent, pipeline: pipeline ?? defaultPipeline, provider: callProvider }, 'Outbound call triggered');

  // TODO: Integrate with Telnyx Call Control API or Twilio REST API
  // For now, return the trigger receipt
  res.json({
    status: 'queued',
    provider: callProvider,
    pipeline: pipeline ?? defaultPipeline,
    recipientPhone,
    agent: agent ?? 'JACK',
  });
});

// ============================================================================
// HTTP + WebSocket Server
// ============================================================================

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Track active calls
const activeCalls = new Map<string, TelnyxMediaStreamHandler>();

wss.on('connection', (ws: WebSocket, req) => {
  const pathname = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;

  // Telnyx WebSocket
  const telnyxMatch = pathname.match(/\/ws\/telnyx\/(.+)/);
  if (telnyxMatch) {
    const callControlId = telnyxMatch[1];
    logger.info({ callControlId }, 'Telnyx WebSocket connected');

    const realtimeClient = process.env.OPENAI_API_KEY
      ? new OpenAIRealtimeClient({
          apiKey: process.env.OPENAI_API_KEY,
          instructions: '', // Set during stream start
        }, logger)
      : undefined;

    const deepgram = process.env.DEEPGRAM_API_KEY
      ? new DeepgramSTTClient({
          apiKey: process.env.DEEPGRAM_API_KEY,
          keepAliveMs: 10000,
          maxConnectionMs: 300000,
        }, logger)
      : undefined;

    const cartesia = process.env.CARTESIA_API_KEY
      ? new CartesiaTTSClient({
          apiKey: process.env.CARTESIA_API_KEY,
          endpoint: 'wss://api.cartesia.ai/tts/websocket',
          voices: {
            JACK: process.env.CARTESIA_VOICE_JACK ?? '',
            JENNY: process.env.CARTESIA_VOICE_JENNY ?? '',
            BUNNY: process.env.CARTESIA_VOICE_BUNNY ?? '',
          },
          outputFormat: { container: 'raw', encoding: 'pcm_mulaw', sampleRate: 8000 },
          speed: 1.0,
        }, logger)
      : undefined;

    const handler = new TelnyxMediaStreamHandler({
      ws,
      realtimeClient,
      deepgram,
      cartesia,
      logger,
      pipelineMode: defaultPipeline,
    });

    activeCalls.set(callControlId, handler);

    ws.on('close', () => {
      activeCalls.delete(callControlId);
      logger.info({ callControlId, active: activeCalls.size }, 'Telnyx call cleaned up');
    });

    return;
  }

  // Twilio WebSocket (backward compatible — delegates to existing handler)
  const twilioMatch = pathname.match(/\/ws\/call\/(.+)/);
  if (twilioMatch) {
    const callSid = twilioMatch[1];
    logger.info({ callSid }, 'Twilio WebSocket connected (legacy path)');
    // Existing Twilio handler from server.ts handles this
    // This hybrid server focuses on Telnyx + Realtime
    ws.close(4001, 'use_legacy_server');
    return;
  }

  logger.warn({ path: pathname }, 'Unknown WebSocket path');
  ws.close(4000, 'unknown_path');
});

// ============================================================================
// Start
// ============================================================================

const PORT = parseInt(process.env.HYBRID_PORT ?? process.env.PORT ?? '3001', 10);

server.listen(PORT, () => {
  logger.info({
    port: PORT,
    defaultPipeline,
    telnyx: !!process.env.TELNYX_API_KEY,
    openaiRealtime: !!process.env.OPENAI_API_KEY,
    deepgram: !!process.env.DEEPGRAM_API_KEY,
    cartesia: !!process.env.CARTESIA_API_KEY,
  }, `Hybrid voice server listening on port ${PORT}`);
});

export { app, server };
