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
import { LLMService } from '../llm/provider.js';
import { ToolExecutor } from '../llm/tool-executor.js';

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

// Shared LLM service (stateless per request, history keyed by conversationId)
const llmService = new LLMService({
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  gpt4oModel: 'gpt-4o',
  claudeModel: 'claude-sonnet-4-5-20250929',
  maxTokens: 300,
  temperature: { 'gpt-4o': 0.3, claude: 0.4 },
}, logger);

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

function createMockServiceRegistry(consentService: any, auditService: any) {
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
    grok: process.env.GROK_VOICE_ENABLED === 'true',
    hubspot: !!process.env.HUBSPOT_ACCESS_TOKEN,
    ghl: !!process.env.GHL_API_KEY,
  }, `Voice agent server listening on port ${PORT}`);
});

export { app, server };
