/**
 * Calculus Voice Agent — Server
 *
 * Express HTTP server + WebSocket server for Telnyx (primary) and Twilio (fallback).
 *
 * Endpoints:
 *   GET  /health                     — Health check + feature flags
 *   POST /webhook/telnyx/inbound     — Telnyx inbound call webhook (TeXML) [PRIMARY]
 *   POST /webhook/telnyx/outbound    — Telnyx outbound call webhook (TeXML) [PRIMARY]
 *   POST /webhook/twilio/inbound     — Twilio inbound call webhook (TwiML) [FALLBACK]
 *   POST /webhook/twilio/status      — Twilio call status callback [FALLBACK]
 *   POST /webhook/twilio/outbound    — Twilio outbound call webhook (TwiML) [FALLBACK]
 *   WS   /ws/telnyx/:callId          — Telnyx media stream [PRIMARY]
 *   WS   /ws/call/:callSid           — Twilio media stream [FALLBACK]
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
import { TelnyxMediaStreamHandler } from './telnyx-stream.js';
import type { VoicePipelineMode } from './telnyx-stream.js';
import { OpenAIRealtimeClient } from './openai-realtime-client.js';
import { DeepgramSTTClient } from './deepgram-client.js';
import { CartesiaTTSClient } from './cartesia-client.js';
import { GHLService } from '../services/crm/ghl-service.js';
import { HubSpotService } from '../services/crm/hubspot-service.js';
import { UnifiedCRMAdapter, DEFAULT_CRM_ROUTING } from '../services/crm/unified-adapter.js';
import { LLMService } from '../llm/provider.js';
import { ToolExecutor } from '../llm/tool-executor.js';
import { SessionService } from '../services/session-service.js';
import { getDatabase } from '../db/client.js';
import { requireValidEnvironment } from '../config/env-validation.js';
import { loadSecretsFromGCP } from '../config/load-secrets.js';
import { requireSwarmEnvironment } from '../config/swarm-guard.js';
import { requireCloudAlignPolicy, getPolicyEngine } from '../config/cloud-align-policy.js';
import { ConversationMemoryService } from '../services/conversation-memory.js';
import { OutboundIntelligenceService } from '../services/outbound-intelligence.js';
import type { OutboundTrigger } from '../services/outbound-intelligence.js';

dotenv.config();

// Primary telecom provider: Telnyx. Twilio is fallback.
// Override with VOICE_PIPELINE_MODE env var ('realtime' | 'modular').
const defaultPipeline: VoicePipelineMode =
  (process.env.VOICE_PIPELINE_MODE as VoicePipelineMode) ?? 'realtime';

// ============================================================================
// Logger
// ============================================================================

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty' }
    : undefined,
});

// Sandbox check — VoiceAI only runs on authorised Swarm VMs (DIRECTIVE-259).
// Fails closed (process.exit 1) if not on swarm-mainframe, swarm-gpu, or fc-ai-portal.
requireSwarmEnvironment(logger);

// Cloud-align identity + role enforcement (CLOUD-ALIGN-001 R5/R4).
// Validates node_id, node_role, environment_id, and allowed_capabilities.
// Hard identity violations → process.exit(1).
requireCloudAlignPolicy(logger);

// Load secrets from GCP Secret Manager (no-op if SECRETS_BACKEND != gcp)
// Must run before requireValidEnvironment so SM-loaded values are available
await loadSecretsFromGCP(logger);

// Validate environment — fail fast if required vars are missing
requireValidEnvironment(logger);

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
    telecom: {
      primary: 'telnyx',
      fallback: 'twilio',
      telnyxEnabled: !!process.env.TELNYX_API_KEY,
      twilioEnabled: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    },
    pipeline: {
      default: defaultPipeline,
      realtime: !!process.env.OPENAI_API_KEY,
      modular: !!(process.env.DEEPGRAM_API_KEY && process.env.CARTESIA_API_KEY),
    },
    cloudAlign: (() => {
      try {
        const engine = getPolicyEngine();
        return {
          node_id: engine.nodeIdentity.node_id,
          node_role: engine.nodeIdentity.node_role,
          environment_id: engine.nodeIdentity.environment_id,
          violations: engine.getViolationSummary(),
        };
      } catch {
        return { error: 'policy engine not initialized' };
      }
    })(),
    features: {
      grokSpeechToSpeech: process.env.GROK_VOICE_ENABLED === 'true',
      outboundAICalls: process.env.ENABLE_OUTBOUND_AI_CALLS === 'true',
      complianceMode: process.env.COMPLIANCE_ENFORCEMENT_MODE ?? 'strict',
      crmGHL: !!process.env.GHL_API_KEY,
      crmHubSpot: !!process.env.HUBSPOT_ACCESS_TOKEN,
      conversationMemory: true,
      outboundIntelligence: !!outboundService,
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
// Telnyx Call Control v1 Webhook (PRIMARY)
//
// Telnyx sends JSON events (call.initiated, call.answered, call.hangup, etc.)
// We respond with REST API calls — NOT TeXML. Bidirectional streaming is set up
// via stream_url in the answer command (for inbound) or in the call placement
// API (for outbound, handled by outbound-intelligence.ts).
// ============================================================================

app.post('/webhook/telnyx/inbound', async (req, res) => {
  // Telnyx Call Control v1 sends: { data: { event_type, payload: {...} } }
  // Telnyx TeXML v2 sends: { From, To, CallControlId, ... }
  // We handle both formats for robustness.
  const data = req.body.data ?? req.body;
  const eventType = data.event_type ?? '';
  const payload = data.payload ?? req.body;

  const callControlId = payload.call_control_id ?? payload.CallControlId ?? '';
  const from = payload.from ?? payload.From ?? '';
  const to = payload.to ?? payload.To ?? '';
  const direction = payload.direction ?? 'inbound';

  logger.info({ eventType: eventType || 'texml', callControlId: callControlId?.substring?.(0, 20), from, to, direction }, 'Telnyx webhook received');

  // For Call Control v1: handle call.initiated by answering + starting stream
  if (eventType === 'call.initiated' && direction === 'inbound') {
    const model = resolveModelFromNumber(to) !== 'DMC' ? resolveModelFromNumber(to) : resolveModelFromNumber(from);
    const wsHost = process.env.WS_HOST || 'voice.calculusresearch.io';
    const streamUrl = `wss://${wsHost}/ws/telnyx/${callControlId}`;
    const telnyxApiKey = process.env.TELNYX_API_KEY ?? '';

    logger.info({ callControlId: callControlId?.substring?.(0, 20), model, streamUrl }, 'Answering inbound call + starting stream');

    // Answer the call
    try {
      await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/answer`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${telnyxApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_state: Buffer.from(JSON.stringify({
            model, direction: 'inbound', callerPhone: from, calledPhone: to,
          })).toString('base64'),
          stream_url: streamUrl,
          stream_track: 'both_tracks',
          stream_bidirectional_mode: 'rtp',
          stream_bidirectional_codec: 'PCMU',
        }),
      });
    } catch (err: any) {
      logger.error({ error: err?.message, callControlId: callControlId?.substring?.(0, 20) }, 'Failed to answer inbound call');
    }

    res.sendStatus(200);
    return;
  }

  // For Call Control v1: other events (answered, hangup, streaming.started, etc.)
  if (eventType) {
    logger.info({ eventType, callControlId: callControlId?.substring?.(0, 20) }, 'Telnyx call event');
    res.sendStatus(200);
    return;
  }

  // TeXML v2 fallback: return XML if body looks like TeXML (has From/To/CallControlId directly)
  if (payload.CallControlId || payload.From) {
    const model = resolveModelFromNumber(to) !== 'DMC' ? resolveModelFromNumber(to) : resolveModelFromNumber(from);
    const wsHost = process.env.WS_HOST || req.headers.host || 'localhost:3000';
    const wsProtocol = process.env.WS_PROTOCOL || 'wss';
    const pipeline = (req.query.pipeline as string) || defaultPipeline;

    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${wsProtocol}://${wsHost}/ws/telnyx/${callControlId}"
            track="both_tracks" codec="PCMU"
            bidirectionalMode="rtp" bidirectionalCodec="PCMU" bidirectionalSamplingRate="8000">
      <Parameter name="model" value="${model}" />
      <Parameter name="direction" value="inbound" />
      <Parameter name="callerPhone" value="${from}" />
      <Parameter name="calledPhone" value="${to}" />
      <Parameter name="pipelineMode" value="${pipeline}" />
    </Stream>
  </Start>
  <Pause length="3600" />
</Response>`);
    return;
  }

  res.sendStatus(200);
});

// Telnyx outbound webhook — for outbound calls placed via the API with stream_url,
// Telnyx doesn't need a webhook response to start streaming (it's already in the API call).
// This handler just logs the event and responds 200.
app.post('/webhook/telnyx/outbound', (req, res) => {
  const data = req.body.data ?? req.body;
  const eventType = data.event_type ?? '';
  const payload = data.payload ?? req.body;
  const callControlId = payload.call_control_id ?? payload.CallControlId ?? '';
  const agent = (req.query.agent as string) || 'JACK';

  logger.info({ eventType: eventType || 'outbound', callControlId: callControlId?.substring?.(0, 20), agent }, 'Telnyx outbound call connected');

  // If TeXML v2 format (has From/To), return XML for backward compat
  if (payload.CallControlId || payload.From) {
    const from = payload.From ?? payload.from ?? '';
    const to = payload.To ?? payload.to ?? '';
    const recipientName = (req.query.recipientName as string) || '';
    const message = (req.query.message as string) || '';
    const wsHost = process.env.WS_HOST || req.headers.host || 'localhost:3000';
    const wsProtocol = process.env.WS_PROTOCOL || 'wss';

    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${wsProtocol}://${wsHost}/ws/telnyx/${callControlId}"
            track="both_tracks" codec="PCMU"
            bidirectionalMode="rtp" bidirectionalCodec="PCMU" bidirectionalSamplingRate="8000">
      <Parameter name="model" value="${agent}" />
      <Parameter name="direction" value="outbound" />
      <Parameter name="callerPhone" value="${from}" />
      <Parameter name="calledPhone" value="${to}" />
      <Parameter name="recipientName" value="${recipientName}" />
      <Parameter name="instructions" value="${message}" />
      <Parameter name="pipelineMode" value="${defaultPipeline}" />
    </Stream>
  </Start>
  <Pause length="3600" />
</Response>`);
    return;
  }

  res.sendStatus(200);
});

// Telnyx status/event callback (catch-all for events we don't handle above)
app.post('/webhook/telnyx/status', (req, res) => {
  const data = req.body.data ?? req.body;
  const eventType = data.event_type ?? '';
  const payload = data.payload ?? {};
  logger.info({ eventType, callControlId: payload.call_control_id?.substring?.(0, 20) }, 'Telnyx call status');
  res.sendStatus(200);
});

// ============================================================================
// Twilio Inbound Call Webhook (FALLBACK)
// ============================================================================

app.post('/webhook/twilio/inbound', (req, res) => {
  const { From, To, CallSid } = req.body;
  logger.info({ from: From, to: To, callSid: CallSid }, 'Inbound call');

  // For inbound: To is our number. For outbound: From is our number.
  const modelFromTo = resolveModelFromNumber(To);
  const model = modelFromTo !== 'DMC' ? modelFromTo : resolveModelFromNumber(From);
  const wsHost = process.env.WS_HOST || req.headers.host || 'localhost:3000';
  const wsProtocol = process.env.WS_PROTOCOL || 'wss';

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
// Outbound Call Webhook (Twilio requests this when an outbound call connects)
// ============================================================================

app.post('/webhook/twilio/outbound', (req, res) => {
  const { CallSid, From, To } = req.body;
  const triggerId = req.query.triggerId as string;
  const agent = (req.query.agent as string) || 'JACK';
  const triggerType = req.query.triggerType as string;
  const recipientName = req.query.recipientName as string;
  const message = req.query.message as string;

  logger.info({ callSid: CallSid, agent, triggerId, triggerType }, 'Outbound call connected');

  const wsHost = process.env.WS_HOST || req.headers.host || 'localhost:3000';
  const wsProtocol = process.env.WS_PROTOCOL || 'wss';

  // Connect to our WebSocket for audio streaming, passing outbound context
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsProtocol}://${wsHost}/ws/call/${CallSid}">
      <Parameter name="model" value="${agent}" />
      <Parameter name="direction" value="outbound" />
      <Parameter name="callerPhone" value="${From}" />
      <Parameter name="calledPhone" value="${To}" />
      <Parameter name="triggerId" value="${triggerId || ''}" />
      <Parameter name="triggerType" value="${triggerType || ''}" />
      <Parameter name="recipientName" value="${recipientName || ''}" />
      <Parameter name="outboundMessage" value="${message || ''}" />
    </Stream>
  </Connect>
</Response>`);
});

// ============================================================================
// Outbound Intelligence API
// ============================================================================

// Queue a new outbound trigger
app.post('/api/outbound/trigger', (req, res) => {
  if (!outboundService) {
    res.status(503).json({ error: 'Outbound service not configured' });
    return;
  }

  try {
    const { type, priority, recipientPhone, recipientName, agent, scheduledAt, context, message, maxAttempts } = req.body;
    const triggerId = outboundService.addTrigger({
      type: type || 'custom',
      priority: priority || 'medium',
      recipientPhone,
      recipientName,
      agent: agent || 'JACK',
      scheduledAt: scheduledAt ? new Date(scheduledAt) : new Date(),
      context: context || {},
      message,
      maxAttempts: maxAttempts || 3,
    });
    res.json({ triggerId, status: 'queued' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Get queue status
app.get('/api/outbound/status', (_req, res) => {
  if (!outboundService) {
    res.status(503).json({ error: 'Outbound service not configured' });
    return;
  }
  res.json(outboundService.getQueueStatus());
});

// Get trigger status
app.get('/api/outbound/trigger/:id', (req, res) => {
  if (!outboundService) {
    res.status(503).json({ error: 'Outbound service not configured' });
    return;
  }
  const trigger = outboundService.getTrigger(req.params.id);
  if (!trigger) {
    res.status(404).json({ error: 'Trigger not found' });
    return;
  }
  res.json(trigger);
});

// Cancel a trigger
app.delete('/api/outbound/trigger/:id', (req, res) => {
  if (!outboundService) {
    res.status(503).json({ error: 'Outbound service not configured' });
    return;
  }
  outboundService.cancelTrigger(req.params.id);
  res.json({ status: 'cancelled' });
});

// ============================================================================
// HTTP + WebSocket Server
// ============================================================================

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Track active calls — Telnyx (primary) and Twilio (fallback)
const activeTelnyxCalls = new Map<string, TelnyxMediaStreamHandler>();
const activeCalls = new Map<string, TwilioMediaStreamHandler>();

// Shared conversation memory service
const conversationMemory = new ConversationMemoryService(logger);

// Outbound intelligence service (Telnyx primary, Twilio fallback)
let outboundService: OutboundIntelligenceService | null = null;
{
  const hasTelnyx = !!process.env.TELNYX_API_KEY;
  const hasTwilio = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);

  if (hasTelnyx || hasTwilio) {
    outboundService = new OutboundIntelligenceService({
      // Twilio (fallback)
      twilioAccountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
      twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? '',
      twilioFromNumbers: {
        JACK: process.env.PHONE_JACK || '+12243850755',
        JENNY: process.env.PHONE_JENNY || '+14014256830',
        BUNNY: process.env.PHONE_BUNNY || '+18338472291',
        CINDY: process.env.PHONE_CINDY || '',
        default: process.env.PHONE_JACK || '+12243850755',
      },
      webhookBaseUrl: process.env.WEBHOOK_BASE_URL || `https://${process.env.WS_HOST || 'localhost:3000'}`,
      maxConcurrentCalls: parseInt(process.env.MAX_CONCURRENT_OUTBOUND ?? '3', 10),
      callWindowStart: parseInt(process.env.CALL_WINDOW_START ?? '0', 10),
      callWindowEnd: parseInt(process.env.CALL_WINDOW_END ?? '24', 10),
      timezone: process.env.CALL_TIMEZONE ?? 'America/New_York',

      // Telnyx (primary) — stream_url passed directly in call API
      telnyxApiKey: process.env.TELNYX_API_KEY,
      telnyxConnectionId: process.env.TELNYX_CONNECTION_ID || '2918176396184389568',
      telnyxFromNumbers: {
        JACK: process.env.TELNYX_NUMBER_1 || '',
        JENNY: process.env.TELNYX_NUMBER_2 || '',
        BUNNY: process.env.TELNYX_NUMBER_3 || '',
        CINDY: process.env.TELNYX_NUMBER_4 || process.env.TELNYX_NUMBER_1 || '',
        default: process.env.TELNYX_NUMBER_1 || '',
      },
      telnyxStreamUrlBase: `wss://${process.env.WS_HOST || 'voice.calculusresearch.io'}`,
    }, logger);
    logger.info({ telnyx: hasTelnyx, twilio: hasTwilio }, 'Outbound intelligence service initialized');
  } else {
    logger.warn('Neither TELNYX_API_KEY nor TWILIO credentials set — outbound intelligence disabled');
  }
}

// Shared LLM service (stateless per request, history keyed by conversationId)
const llmService = new LLMService({
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  gpt4oModel: 'gpt-4o',
  claudeModel: 'claude-sonnet-4-5-20250929',
  maxTokens: 300,
  temperature: { 'gpt-4o': 0.3, claude: 0.4 },
  xaiApiKey: process.env.XAI_API_KEY ?? '',
}, logger);

// Session service + router training log (requires DATABASE_URL)
let sessionService: SessionService | null = null;
if (process.env.DATABASE_URL) {
  try {
    const db = getDatabase({
      connectionString: process.env.DATABASE_URL,
      maxConnections: 20,
      idleTimeoutMs: 30000,
      connectionTimeoutMs: 5000,
    }, logger);
    sessionService = new SessionService(db, logger);

    // Wire adaptive_provider_router training data collection
    llmService.setRouterLogger((entry) => {
      sessionService!.insertRouterLog(entry).catch((err: Error) => {
        logger.warn({ error: err.message }, 'router_log_insert_failed');
      });
    });
    logger.info('router_training_log wired (adaptive_provider_router)');
  } catch (err: any) {
    logger.warn({ error: err?.message }, 'session_service_init_failed — router training disabled');
  }
}

wss.on('connection', (ws: WebSocket, req) => {
  const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // ── Telnyx (PRIMARY) ──────────────────────────────────────────────────────
  const telnyxMatch = pathname.match(/\/ws\/telnyx\/(.+)/);
  if (telnyxMatch) {
    const callControlId = telnyxMatch[1];
    logger.info({ callControlId }, 'Telnyx WebSocket connected [primary]');

    const realtimeClient = process.env.OPENAI_API_KEY
      ? new OpenAIRealtimeClient({ apiKey: process.env.OPENAI_API_KEY, instructions: '' }, logger)
      : undefined;

    const telnyxDeepgram = new DeepgramSTTClient({
      apiKey: process.env.DEEPGRAM_API_KEY ?? '',
      keepAliveMs: 10000,
      maxConnectionMs: 300000,
    }, logger);

    const fallback = process.env.CARTESIA_VOICE_ID ?? '';
    const telnyxCartesia = new CartesiaTTSClient({
      apiKey: process.env.CARTESIA_API_KEY ?? '',
      endpoint: 'wss://api.cartesia.ai/tts/websocket',
      voices: {
        DMC: process.env.CARTESIA_VOICE_DMC || fallback,
        CONSTITUTIONAL_TENDER: process.env.CARTESIA_VOICE_CT || fallback,
        TILT: process.env.CARTESIA_VOICE_TILT || fallback,
        EUREKA: process.env.CARTESIA_VOICE_EUREKA || fallback,
        IFSE: process.env.CARTESIA_VOICE_IFSE || fallback,
        JACK: process.env.CARTESIA_VOICE_JACK || fallback,
        JENNY: process.env.CARTESIA_VOICE_JENNY || fallback,
        BUNNY: process.env.CARTESIA_VOICE_BUNNY || fallback,
        CINDY: process.env.CARTESIA_VOICE_CINDY || fallback,
        MORTGAGE: process.env.CARTESIA_VOICE_MORTGAGE || fallback,
        REAL_ESTATE: process.env.CARTESIA_VOICE_RE || fallback,
        LOAN_SERVICING: process.env.CARTESIA_VOICE_LS || fallback,
      },
      outputFormat: { container: 'raw', encoding: 'pcm_mulaw', sampleRate: 8000 },
      speed: 1.0,
    }, logger);

    const telnyxHandler = new TelnyxMediaStreamHandler({
      ws,
      realtimeClient,
      deepgram: telnyxDeepgram,
      cartesia: telnyxCartesia,
      llm: llmService,
      logger,
      pipelineMode: defaultPipeline,
    });

    // Pass agent context from URL query params (set by outbound-intelligence.ts)
    // or from the callControlId path segment which may encode the trigger context
    const qp = parsedUrl.searchParams;
    if (qp.has('model') || qp.has('agent') || qp.has('direction')) {
      telnyxHandler.setPreConfig({
        model: (qp.get('model') ?? qp.get('agent') ?? undefined) as any,
        direction: (qp.get('direction') ?? undefined) as any,
        recipientName: qp.get('recipientName') ?? undefined,
        instructions: qp.get('message') ?? qp.get('instructions') ?? undefined,
      });
    }

    activeTelnyxCalls.set(callControlId, telnyxHandler);
    ws.on('close', () => {
      activeTelnyxCalls.delete(callControlId);
      logger.info({ callControlId, active: activeTelnyxCalls.size }, 'Telnyx call cleaned up');
    });
    return;
  }

  // ── Twilio (FALLBACK) ─────────────────────────────────────────────────────
  const callSidMatch = pathname.match(/\/ws\/call\/(.+)/);

  if (!callSidMatch) {
    logger.warn({ path: pathname }, 'Unknown WebSocket path');
    ws.close(4000, 'unknown_path');
    return;
  }

  const callSid = callSidMatch[1];
  logger.info({ callSid }, 'Twilio WebSocket connected [fallback]');

  // Create per-call instances
  // In production these would be pooled/reused where possible

  const consentService = createMockConsentService();
  const auditService = createMockAuditService();

  const compliance = new ComplianceEnforcer(
    { ...DEFAULT_COMPLIANCE_CONFIG, enforcement: 'advisory' },
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
    voices: (() => {
      const fallback = process.env.CARTESIA_VOICE_ID ?? '';
      return {
        DMC: process.env.CARTESIA_VOICE_DMC || fallback,
        CONSTITUTIONAL_TENDER: process.env.CARTESIA_VOICE_CT || fallback,
        TILT: process.env.CARTESIA_VOICE_TILT || fallback,
        EUREKA: process.env.CARTESIA_VOICE_EUREKA || fallback,
        IFSE: process.env.CARTESIA_VOICE_IFSE || fallback,
        JACK: process.env.CARTESIA_VOICE_JACK || fallback,
        JENNY: process.env.CARTESIA_VOICE_JENNY || fallback,
        BUNNY: process.env.CARTESIA_VOICE_BUNNY || fallback,
        CINDY: process.env.CARTESIA_VOICE_CINDY || fallback,
        MORTGAGE: process.env.CARTESIA_VOICE_MORTGAGE || fallback,
        REAL_ESTATE: process.env.CARTESIA_VOICE_RE || fallback,
        LOAN_SERVICING: process.env.CARTESIA_VOICE_LS || fallback,
      };
    })(),
    outputFormat: { container: 'raw', encoding: 'pcm_mulaw', sampleRate: 8000 },
    speed: 1.0,
  }, logger);

  // Tool executor with mock services (replace with real implementations)
  const toolExecutor = new ToolExecutor(
    createMockServiceRegistry(consentService, auditService),
    logger,
  );

  const handler = new TwilioMediaStreamHandler({
    ws,
    pipelineController,
    deepgram,
    cartesia,
    llm: llmService,
    toolExecutor,
    conversationMemory,
    logger,
    onQualityScore: sessionService
      ? (conversationId, score) => sessionService!.updateRouterQualityScores(conversationId, score, 'auto_eval')
      : undefined,
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
    getConsent: async () => ({
      consentId: 'mock-consent',
      phone: '',
      type: 'express',
      channel: 'voice',
      granted: true,
      grantedAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 86400000),
      source: 'mock',
      revocationHistory: [],
      reOptedInAfterLastRevocation: false,
      aiWrittenConsent: false,
      aiConsentTimestamp: null,
      aiConsentSeller: null,
      automatedConsent: true,
      consentLanguage: 'en',
      consentText: 'Mock consent for development',
      consentMethod: 'verbal',
      consentRecordedBy: 'system',
      consentRecordedAt: new Date(),
      consentIP: null,
    } as any),
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

function createMockServiceRegistry(consentService: any, auditService: any): any {
  const notImplemented = (name: string) => async (..._args: any[]) => {
    logger.warn({ service: name }, 'Mock service called — not implemented');
    return { mock: true, service: name };
  };

  return {
    nymbus: {
      getAccountBalances: async (customerId: string) => ([
        { accountId: 'CHK-001', type: 'checking', balance: 4523.87, currency: 'USD', available: 4423.87 },
        { accountId: 'SAV-001', type: 'savings', balance: 12050.00, currency: 'USD', available: 12050.00 },
      ]),
      getRecentTransactions: async () => ([
        { date: '2026-02-27', description: 'Direct Deposit - Employer', amount: 3200.00, type: 'credit' },
        { date: '2026-02-26', description: 'Amazon.com', amount: -47.99, type: 'debit' },
        { date: '2026-02-25', description: 'Starbucks #1234', amount: -6.75, type: 'debit' },
      ]),
      getCardStatus: async () => ({ cardLast4: '4582', status: 'active', type: 'debit' }),
      getPayees: async () => ([
        { payeeId: 'P-001', name: 'Eversource Energy', category: 'utilities' },
        { payeeId: 'P-002', name: 'AT&T Wireless', category: 'telecom' },
      ]),
      scheduleBillPay: async (params: any) => ({ confirmationId: 'BP-' + Date.now(), scheduled: true }),
      getScheduledPayments: async () => ([]),
      getPaymentMethods: notImplemented('nymbus.getPaymentMethods'),
      getSettlementAccount: notImplemented('nymbus.getSettlementAccount'),
    },
    pricing: {
      getSpotPrice: async (metal: string) => ({
        metal,
        askPrice: metal === 'gold' ? 2412.50 : metal === 'silver' ? 28.45 : 985.30,
        currency: 'USD',
        unit: 'oz',
        timestamp: new Date().toISOString(),
        source: 'ICE Benchmark',
      }),
      lockPrice: async (metal: string, direction: string, weightOz: number) => ({
        lockId: 'LOCK-' + Date.now(),
        metal, direction, weightOz,
        lockedPrice: metal === 'gold' ? 2412.50 : 28.45,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
      }),
      getBidPrice: async (metal: string) => ({
        metal,
        bidPrice: metal === 'gold' ? 2408.20 : 28.32,
        timestamp: new Date().toISOString(),
      }),
    },
    wholesaler: {
      checkAvailability: async (metal: string, weightOz: number) => ({
        available: true, metal, weightOz, estimatedSettlement: '2 business days',
      }),
      executeOrder: notImplemented('wholesaler.executeOrder'),
    },
    custodian: {
      getHoldings: async () => ([
        { holdingId: 'H-001', metal: 'gold', weightOz: 25.0, vault: 'Delaware Depository', purity: 0.999 },
        { holdingId: 'H-002', metal: 'silver', weightOz: 500.0, vault: 'Brinks Salt Lake', purity: 0.999 },
      ]),
      getVaultOptions: async () => ([
        { vaultId: 'V-DD', name: 'Delaware Depository', location: 'Wilmington, DE' },
        { vaultId: 'V-BSL', name: 'Brinks Salt Lake', location: 'Salt Lake City, UT' },
      ]),
      getEncumbranceStatus: async () => ({ encumbered: false, pledgedTo: null }),
      getTransferFeeEstimate: async () => ({ fee: 45.00, currency: 'USD' }),
      requestLock: notImplemented('custodian.requestLock'),
      validateTransferRoute: notImplemented('custodian.validateTransferRoute'),
      createTransferRequest: notImplemented('custodian.createTransferRequest'),
      getLockStatus: notImplemented('custodian.getLockStatus'),
    },
    tilt: {
      calculateIndicativeDSCR: async (noi: number, loanAmount: number, rate: number, term: number) => {
        const annualDebtService = loanAmount * (rate / (1 - Math.pow(1 + rate, -term)));
        const dscr = noi / annualDebtService;
        return { indicativeDSCR: Math.round(dscr * 100) / 100, noi, loanAmount, disclaimer: 'Subject to underwriting' };
      },
      createLead: async (params: any) => ({ leadId: 'LEAD-' + Date.now(), status: 'new', ...params }),
      getExistingBorrower: notImplemented('tilt.getExistingBorrower'),
      getLoanPrograms: async () => ([
        { name: 'DSCR 30-Year Fixed', minDSCR: 1.25, rateRange: '7.0-8.5%', ltv: 75 },
        { name: 'Bridge 12-Month', minDSCR: 1.0, rateRange: '9.0-11.0%', ltv: 80 },
      ]),
    },
    loanpro: {
      getLoanDetails: async () => ({
        loanId: 'LN-2025-001', balance: 1_250_000, rate: 0.075, maturity: '2030-03-01', status: 'current',
      }),
      getPaymentSchedule: async () => ([
        { date: '2026-03-01', amount: 9_375.00, type: 'interest', status: 'upcoming' },
      ]),
      getPayoffQuote: async () => ({
        payoffAmount: 1_255_200, validThrough: '2026-03-07', perDiem: 256.85,
      }),
      getEscrowBalance: async () => ({ balance: 18_750.00, lastDeposit: '2026-02-01' }),
    },
    eureka: {
      getSettlementStatus: async () => ({
        fileId: 'SF-2026-042', stage: 'docs_pending', parties: 3, pendingItems: 2,
      }),
      generateChecklist: async () => ([
        { item: 'Title insurance commitment', status: 'pending' },
        { item: 'Survey', status: 'received' },
        { item: 'Wire instructions', status: 'pending' },
      ]),
      createSettlementFile: notImplemented('eureka.createSettlementFile'),
      getPartyRequirements: notImplemented('eureka.getPartyRequirements'),
    },
    ifse: {
      getPendingWires: async () => ([
        { wireId: 'W-001', amount: 250_000, currency: 'USD', beneficiary: 'Deutsche Bank', status: 'pending_review' },
      ]),
      getFXExposure: async () => ({ totalExposure: 1_200_000, currency: 'EUR', hedgeRatio: 0.65 }),
      getSettlementQueueStatus: async () => ({ pending: 12, inProgress: 3, completedToday: 28 }),
      generateReconReport: async () => ({ matched: 145, unmatched: 3, exceptions: 1 }),
      getCorridorStatus: notImplemented('ifse.getCorridorStatus'),
      getFXQuote: notImplemented('ifse.getFXQuote'),
      createWireRequest: notImplemented('ifse.createWireRequest'),
    },
    sanctions: {
      screenBeneficiary: async () => ({ cleared: true, requiresManualReview: false }),
    },
    crm: {
      createTicket: async (params: any) => ({ ticketId: 'TKT-' + Date.now(), status: 'open', createdAt: new Date(), updatedAt: new Date() }),
      getTicketStatus: async () => ({ ticketId: 'TKT-001', status: 'open', createdAt: new Date(), updatedAt: new Date() }),
      searchFAQ: async (query: string) => ([
        { question: 'How do I reset my password?', answer: 'You can reset your password by visiting the login page and clicking Forgot Password.', relevanceScore: 0.9 },
      ]),
      getContact: async () => null,
      getContactByPhone: async () => null,
      getContactByEmail: async () => null,
      createContact: async (params: any) => ({ contactId: 'C-' + Date.now(), ...params, source: 'voice_agent' }),
      updateContact: async () => ({}),
      createDeal: async (params: any) => ({ dealId: 'D-' + Date.now(), ...params }),
      getDeal: async () => null,
      updateDealStage: async () => ({}),
      getDealsForContact: async () => ([]),
      createLead: async () => ({}),
      qualifyLead: async () => ({}),
      assignLead: async () => {},
      createTask: async () => ({}),
      addNote: async () => ({ noteId: 'N-' + Date.now() }),
      logCall: async () => 'CALL-' + Date.now(),
      getActivityTimeline: async () => ([]),
      enrollInSequence: async () => {},
      removeFromSequence: async () => {},
      triggerWorkflow: async () => {},
      getAvailableSlots: async () => ([]),
      bookAppointment: async () => ({ appointmentId: 'APT-' + Date.now(), status: 'scheduled' }),
      cancelAppointment: async () => {},
      addTag: async () => {},
      removeTag: async () => {},
      addToList: async () => {},
      searchContacts: async () => ([]),
      flagAccount: async () => {},
      recordConsent: async () => {},
      getConsentHistory: async () => ([]),
    },
    consent: consentService,
    audit: auditService,
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
    telecom: {
      primary: 'telnyx',
      telnyx: !!process.env.TELNYX_API_KEY,
      twilio: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    },
    pipeline: { default: defaultPipeline },
    grok: process.env.GROK_VOICE_ENABLED === 'true',
    hubspot: !!process.env.HUBSPOT_ACCESS_TOKEN,
    ghl: !!process.env.GHL_API_KEY,
  }, `Voice agent server listening on port ${PORT}`);
});

export { app, server };
