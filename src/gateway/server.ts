/**
 * Calculus Voice Agent — Server
 *
 * Express HTTP server + WebSocket server for Twilio Media Streams.
 *
 * Endpoints:
 *   GET  /health                    — Health check + feature flags
 *   POST /webhook/twilio/inbound    — Twilio inbound call webhook (returns TwiML)
 *   POST /webhook/twilio/status     — Twilio call status callback
 *   WS   /ws/call/:callSid         — Media stream WebSocket
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import pino from 'pino';
import dotenv from 'dotenv';
import { URL } from 'url';

import { ComplianceEnforcer, DEFAULT_COMPLIANCE_CONFIG } from '../compliance/enforcer.js';
import { VoicePipelineController } from './pipeline-controller.js';
import { TwilioMediaStreamHandler, resolveModelFromNumber } from './twilio-stream.js';
import { DeepgramSTTClient } from './deepgram-client.js';
import { CartesiaTTSClient } from './cartesia-client.js';
import { GHLService } from '../services/crm/ghl-service.js';
import { HubSpotService } from '../services/crm/hubspot-service.js';
import { UnifiedCRMAdapter, DEFAULT_CRM_ROUTING } from '../services/crm/unified-adapter.js';

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

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '0.1.0',
    uptime: process.uptime(),
    features: {
      grokSpeechToSpeech: process.env.GROK_VOICE_ENABLED === 'true',
      outboundAICalls: process.env.ENABLE_OUTBOUND_AI_CALLS === 'true',
      complianceMode: process.env.COMPLIANCE_ENFORCEMENT_MODE ?? 'strict',
      crmGHL: !!process.env.GHL_API_KEY,
      crmHubSpot: !!process.env.HUBSPOT_ACCESS_TOKEN,
    },
    routing: {
      intentClassification: 'gpt-4o',
      simpleResponses: 'gpt-4o',
      complianceSensitive: 'claude',
      informationalQueries: 'grok-voice',
    },
  });
});

// ============================================================================
// Twilio Inbound Call Webhook
// ============================================================================

app.post('/webhook/twilio/inbound', (req, res) => {
  const { From, To, CallSid } = req.body;
  logger.info({ from: From, to: To, callSid: CallSid }, 'Inbound call');

  const model = resolveModelFromNumber(To);
  const wsHost = req.headers.host ?? 'localhost:3000';
  const wsProtocol = process.env.NODE_ENV === 'production' ? 'wss' : 'wss';

  // Return TwiML — connects to our WebSocket for audio streaming
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsProtocol}://${wsHost}/ws/call/${CallSid}">
      <Parameter name="model" value="${model}" />
      <Parameter name="direction" value="inbound" />
      <Parameter name="callerPhone" value="${From}" />
      <Parameter name="calledPhone" value="${To}" />
    </Stream>
  </Connect>
</Response>`);
});

// Twilio status callback
app.post('/webhook/twilio/status', (req, res) => {
  const { CallSid, CallStatus, Duration } = req.body;
  logger.info({ callSid: CallSid, status: CallStatus, duration: Duration }, 'Call status');
  res.sendStatus(200);
});

// ============================================================================
// HTTP + WebSocket Server
// ============================================================================

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Track active calls
const activeCalls = new Map<string, TwilioMediaStreamHandler>();

wss.on('connection', (ws: WebSocket, req) => {
  const pathname = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;
  const callSidMatch = pathname.match(/\/ws\/call\/(.+)/);

  if (!callSidMatch) {
    logger.warn({ path: pathname }, 'Unknown WebSocket path');
    ws.close(4000, 'unknown_path');
    return;
  }

  const callSid = callSidMatch[1];
  logger.info({ callSid }, 'WebSocket connected for call');

  // Create per-call instances
  // In production these would be pooled/reused where possible

  const consentService = createMockConsentService();
  const auditService = createMockAuditService();

  const compliance = new ComplianceEnforcer(
    DEFAULT_COMPLIANCE_CONFIG,
    consentService,
    auditService,
    logger,
  );

  const pipelineController = new VoicePipelineController({
    config: {
      deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? '',
      cartesiaApiKey: process.env.CARTESIA_API_KEY ?? '',
      xaiApiKey: process.env.XAI_API_KEY ?? '',
      openaiApiKey: process.env.OPENAI_API_KEY ?? '',
      anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
      enableGrokSpeechToSpeech: process.env.GROK_VOICE_ENABLED === 'true',
      maxRetries: 3,
      silenceTimeoutMs: 30000,
    },
    compliance,
    auditService,
    consentService,
    logger,
  });

  const deepgram = new DeepgramSTTClient({
    apiKey: process.env.DEEPGRAM_API_KEY ?? '',
    keepAliveMs: 10000,
    maxConnectionMs: 300000, // 5 min
  }, logger);

  const cartesia = new CartesiaTTSClient({
    apiKey: process.env.CARTESIA_API_KEY ?? '',
    endpoint: 'wss://api.cartesia.ai/tts/websocket',
    voices: {
      DMC: process.env.CARTESIA_VOICE_DMC ?? '',
      CONSTITUTIONAL_TENDER: process.env.CARTESIA_VOICE_CT ?? '',
      TILT: process.env.CARTESIA_VOICE_TILT ?? '',
      EUREKA: process.env.CARTESIA_VOICE_EUREKA ?? '',
      IFSE: process.env.CARTESIA_VOICE_IFSE ?? '',
    },
    outputFormat: { container: 'raw', encoding: 'pcm_s16le', sampleRate: 16000 },
    speed: 1.0,
  }, logger);

  const handler = new TwilioMediaStreamHandler({
    ws,
    pipelineController,
    deepgram,
    cartesia,
    logger,
  });

  activeCalls.set(callSid, handler);

  ws.on('close', () => {
    activeCalls.delete(callSid);
    logger.info({ callSid, activeCalls: activeCalls.size }, 'Call cleaned up');
  });
});

// ============================================================================
// Mock Services (replace with real implementations)
// ============================================================================

function createMockConsentService() {
  return {
    getConsent: async () => null,
    captureConsent: async () => ({} as any),
    revokeConsent: async () => {},
    checkDNC: async () => ({
      onNationalDNC: false,
      onStateDNC: false,
      onInternalSuppression: false,
      numberReassigned: false,
    }),
    addToSuppression: async () => {},
  };
}

function createMockAuditService() {
  return {
    logEvent: async (event: any) => {
      logger.info({ eventType: event.eventType }, 'Audit event');
      return 'mock-event-id';
    },
    getConversationAudit: async () => [],
  };
}

// ============================================================================
// Start
// ============================================================================

const PORT = parseInt(process.env.PORT ?? '3000', 10);

server.listen(PORT, () => {
  logger.info({
    port: PORT,
    env: process.env.NODE_ENV ?? 'development',
    grok: process.env.GROK_VOICE_ENABLED === 'true',
    hubspot: !!process.env.HUBSPOT_ACCESS_TOKEN,
    ghl: !!process.env.GHL_API_KEY,
  }, `Voice agent server listening on port ${PORT}`);
});

export { app, server };
