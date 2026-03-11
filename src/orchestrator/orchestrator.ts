/**
 * Conversation Orchestrator — State Machine & Intent Router
 *
 * Maps to Spec Section 1 Component 2 (Conversation Orchestrator).
 * Now includes Grok Voice Agent API as fourth LLM option in
 * Orchestra DSL routing, alongside GPT-4o, Claude, and Grok.
 *
 * Routing Strategy:
 *   - GPT-4o:  Fast intent classification, simple responses
 *   - Claude:  Compliance-sensitive flows, complex reasoning
 *   - Grok:    Informational queries, outbound alerts (speech-to-speech)
 *   - Fallback: GPT-4o (never leave caller in silence)
 */

import { v4 as uuid } from 'uuid';
import type {
  AuthTier,
  CalcModel,
  CallDirection,
  Intent,
  VoiceSession,
  ActionRecord,
  EscalationRecord,
} from '../types.js';
import {
  INTENT_AUTH_REQUIREMENTS,
  HUMAN_ESCALATION_THRESHOLDS,
} from '../types.js';
import type { ComplianceEnforcer, TranscriptTrigger } from '../compliance/enforcer.js';
import type { IAuditService } from '../services/contracts.js';
import type { Logger } from 'pino';

// ============================================================================
// Orchestra DSL — Multi-LLM Router (Updated with Grok)
// ============================================================================

export type LLMProvider = 'gpt-4o' | 'claude' | 'grok-voice';

/**
 * Pipeline mode determines how audio flows through the system:
 *
 * 'modular' — STT (Deepgram) → LLM → TTS (Cartesia)
 *   Used for: compliance-sensitive, transactional, multi-step flows
 *   Advantage: ComplianceEnforcer gates inspect every transcript chunk
 *
 * 'speech-to-speech' — Audio → Grok → Audio
 *   Used for: informational queries, outbound alerts, simple support
 *   Advantage: Lower latency, lower cost, more natural speech
 *   Risk: No real-time transcript inspection (post-call audit only)
 */
export type PipelineMode = 'modular' | 'speech-to-speech';

export interface OrchestraRoutingConfig {
  intentClassification: LLMProvider;
  simpleResponses: LLMProvider;
  multiStepFlows: LLMProvider;
  complianceSensitive: LLMProvider;
  objectionHandling: LLMProvider;
  informationalQueries: LLMProvider;
  outboundAlerts: LLMProvider;

  latencyBudgets: {
    intentClassification: number;
    simpleResponse: number;
    complexFlow: number;
    speechToSpeech: number;
  };

  /** Cost per minute by provider */
  costPerMinute: {
    'gpt-4o': number;
    'claude': number;
    'grok-voice': number;
  };

  fallback: LLMProvider;

  /** When to use speech-to-speech vs modular pipeline */
  grokEligibleIntents: Intent[];

  /** Intents that MUST use modular pipeline (ComplianceEnforcer required) */
  modularRequiredIntents: Intent[];
}

export const DEFAULT_ORCHESTRA_CONFIG: OrchestraRoutingConfig = {
  intentClassification: 'gpt-4o',
  simpleResponses: 'gpt-4o',
  multiStepFlows: 'claude',
  complianceSensitive: 'claude',
  objectionHandling: 'claude',
  informationalQueries: 'grok-voice',
  outboundAlerts: 'grok-voice',

  latencyBudgets: {
    intentClassification: 200,
    simpleResponse: 500,
    complexFlow: 800,
    speechToSpeech: 300,   // Grok native — sub-300ms expected
  },

  costPerMinute: {
    'gpt-4o': 0.077,      // Deepgram + GPT-4o + Cartesia
    'claude': 0.087,       // Deepgram + Claude + Cartesia
    'grok-voice': 0.05,    // Flat rate, all-inclusive
  },

  fallback: 'gpt-4o',

  // Grok-eligible: informational, no money movement, no compliance gates needed
  grokEligibleIntents: [
    'metal_price_check' as Intent,
    'balance_inquiry' as Intent,     // Read-only, Tier 1
    'card_status' as Intent,         // Read-only, Tier 1
    'fee_explanation' as Intent,     // Tier 0
    'branch_location' as Intent,     // Tier 0
    'general_question' as Intent,    // Tier 0
    'payment_inquiry' as Intent,     // Read-only, Tier 1
    'escrow_inquiry' as Intent,      // Read-only, Tier 1
    'settlement_status' as Intent,   // Read-only, Tier 1
    'custody_receipt' as Intent,     // Read-only, Tier 1
    // IFSE staff queries (internal, already authed via SSO)
    'fx_exposure' as Intent,
    'pending_wires' as Intent,
    'settlement_queue' as Intent,
    'recon_report' as Intent,
  ],

  // MUST use modular pipeline — ComplianceEnforcer gates required
  modularRequiredIntents: [
    'buy_metal' as Intent,
    'sell_metal' as Intent,
    'teleport_transfer' as Intent,
    'bill_pay' as Intent,
    'domestic_transfer' as Intent,
    'international_transfer' as Intent,
    'loan_intake' as Intent,
    'settlement_setup' as Intent,
    'instant_liquidity' as Intent,
    'payoff_quote' as Intent,     // Financial data — accuracy gate
    'delinquency_inquiry' as Intent,  // Sensitive — tone matters
  ],
};

/** Determine LLM + pipeline mode for an intent */
export function routeIntent(
  intent: Intent,
  config: OrchestraRoutingConfig = DEFAULT_ORCHESTRA_CONFIG
): RoutingDecision {
  // Modular-required intents → Claude or GPT-4o with full ComplianceEnforcer
  if (config.modularRequiredIntents.includes(intent)) {
    const isCompliance = [
      'buy_metal', 'sell_metal', 'teleport_transfer',
      'international_transfer', 'instant_liquidity', 'settlement_setup',
    ].includes(intent);

    const isMultiStep = [
      'loan_intake', 'settlement_setup', 'bill_pay', 'domestic_transfer',
    ].includes(intent);

    return {
      provider: isCompliance || isMultiStep ? 'claude' : 'gpt-4o',
      pipelineMode: 'modular',
      latencyBudget: isCompliance || isMultiStep
        ? config.latencyBudgets.complexFlow
        : config.latencyBudgets.simpleResponse,
      complianceGatesActive: true,
      estimatedCostPerMin: isCompliance || isMultiStep
        ? config.costPerMinute['claude']
        : config.costPerMinute['gpt-4o'],
    };
  }

  // Grok-eligible intents → speech-to-speech
  if (config.grokEligibleIntents.includes(intent)) {
    return {
      provider: 'grok-voice',
      pipelineMode: 'speech-to-speech',
      latencyBudget: config.latencyBudgets.speechToSpeech,
      complianceGatesActive: false,  // Post-call audit only
      estimatedCostPerMin: config.costPerMinute['grok-voice'],
    };
  }

  // Unknown or unclassified → GPT-4o modular (safe default)
  return {
    provider: 'gpt-4o',
    pipelineMode: 'modular',
    latencyBudget: config.latencyBudgets.simpleResponse,
    complianceGatesActive: true,
    estimatedCostPerMin: config.costPerMinute['gpt-4o'],
  };
}

export interface RoutingDecision {
  provider: LLMProvider;
  pipelineMode: PipelineMode;
  latencyBudget: number;
  complianceGatesActive: boolean;
  estimatedCostPerMin: number;
}

// ============================================================================
// Conversation State
// ============================================================================

export type ConversationPhase =
  | 'greeting'
  | 'disclosure'
  | 'recording_consent'
  | 'authentication'
  | 'intent_detection'
  | 'flow_execution'
  | 'confirmation'
  | 'escalation'
  | 'wrap_up'
  | 'ended';

export interface ConversationState {
  conversationId: string;
  phase: ConversationPhase;
  model: CalcModel;
  currentIntent: Intent | null;
  authTier: AuthTier;
  flowState: Record<string, unknown>;
  turnCount: number;
  pendingActions: string[];
  disclosureDelivered: boolean;
  recordingConsentObtained: boolean;
  escalated: boolean;
  escalationReason: string | null;

  /** Active pipeline mode — can change mid-call on intent switch */
  activePipeline: PipelineMode;

  /** LLM routing for current turn */
  activeProvider: LLMProvider;

  /** Running cost accumulator */
  estimatedCostCents: number;
}

// ============================================================================
// Orchestrator
// ============================================================================

export class ConversationOrchestrator {
  private state: ConversationState;
  private compliance: ComplianceEnforcer;
  private auditService: IAuditService;
  private logger: Logger;
  private routingConfig: OrchestraRoutingConfig;

  constructor(params: {
    conversationId: string;
    model: CalcModel;
    initialAuthTier: AuthTier;
    compliance: ComplianceEnforcer;
    auditService: IAuditService;
    logger: Logger;
    routingConfig?: OrchestraRoutingConfig;
  }) {
    this.state = {
      conversationId: params.conversationId,
      phase: 'greeting',
      model: params.model,
      currentIntent: null,
      authTier: params.initialAuthTier,
      flowState: {},
      turnCount: 0,
      pendingActions: [],
      disclosureDelivered: false,
      recordingConsentObtained: false,
      escalated: false,
      escalationReason: null,
      activePipeline: 'modular', // Start modular until intent is classified
      activeProvider: 'gpt-4o',
      estimatedCostCents: 0,
    };
    this.compliance = params.compliance;
    this.auditService = params.auditService;
    this.logger = params.logger.child({
      component: 'Orchestrator',
      conversationId: params.conversationId,
    });
    this.routingConfig = params.routingConfig ?? DEFAULT_ORCHESTRA_CONFIG;
  }

  // ==========================================================================
  // Main Turn Processing
  // ==========================================================================

  async processTurn(utterance: string): Promise<TurnResult> {
    this.state.turnCount++;

    // ---- Compliance checks run on EVERY turn (modular pipeline only) ----
    if (this.state.activePipeline === 'modular') {
      const trigger = this.compliance.checkTranscriptForTriggers(utterance);
      if (trigger) {
        return this.handleComplianceTrigger(trigger);
      }

      const piiDetections = this.compliance.detectPII(utterance);
      if (piiDetections.length > 0) {
        this.logger.warn({ pii: piiDetections }, 'PII detected in caller speech');
        return {
          type: 'respond',
          provider: 'gpt-4o',
          pipelineMode: 'modular',
          latencyBudget: 500,
          responseInstruction: `The caller just shared sensitive personal information. Politely interrupt: "For your security, please don't share card numbers or Social Security numbers over the phone. I can direct you to our secure portal at constitutionaltender.com."`,
          tools: [],
          metadata: { piiDetected: true },
        };
      }
    }

    // ---- Phase routing ----
    switch (this.state.phase) {
      case 'greeting':
      case 'disclosure':
        return this.handleDisclosurePhase();

      case 'recording_consent':
        return this.handleRecordingConsentPhase(utterance);

      case 'authentication':
        return this.handleAuthenticationPhase(utterance);

      case 'intent_detection':
        return this.handleIntentDetection(utterance);

      case 'flow_execution':
        return this.handleFlowExecution(utterance);

      case 'confirmation':
        return this.handleConfirmation(utterance);

      case 'escalation':
        return {
          type: 'escalate',
          reason: this.state.escalationReason ?? 'unknown',
          context: this.buildHandoffContext(),
          responseText: 'One moment while I connect you with a specialist.',
        };

      case 'wrap_up':
        return {
          type: 'respond',
          provider: 'gpt-4o',
          pipelineMode: 'modular',
          latencyBudget: 500,
          responseInstruction: 'Ask if there is anything else. If not, thank them and say goodbye warmly.',
          tools: [],
        };

      default:
        return this.handleFlowExecution(utterance);
    }
  }

  // ==========================================================================
  // Phase Handlers
  // ==========================================================================

  private handleDisclosurePhase(): TurnResult {
    this.state.disclosureDelivered = true;
    this.state.phase = 'intent_detection';

    // Disclosure is always modular (pre-recorded or TTS)
    return {
      type: 'system_action',
      action: 'deliver_disclosure',
      nextPhase: 'intent_detection',
    };
  }

  private handleRecordingConsentPhase(utterance: string): TurnResult {
    const lower = utterance.toLowerCase();
    const yes = ['yes', 'yeah', 'sure', 'okay', 'fine', 'go ahead', 'that\'s fine', 'uh huh'];
    const no = ['no', 'nope', 'don\'t record', 'no recording', 'i\'d rather not'];

    if (yes.some(w => lower.includes(w))) {
      this.state.recordingConsentObtained = true;
      this.state.phase = 'intent_detection';
      return { type: 'system_action', action: 'enable_recording', nextPhase: 'intent_detection' };
    }

    if (no.some(w => lower.includes(w))) {
      this.state.recordingConsentObtained = false;
      this.state.phase = 'intent_detection';
      return { type: 'system_action', action: 'disable_recording', nextPhase: 'intent_detection' };
    }

    return {
      type: 'respond',
      provider: 'gpt-4o',
      pipelineMode: 'modular',
      latencyBudget: 300,
      responseInstruction: 'Re-ask: "Just to confirm — is it okay if this call is recorded for quality assurance?"',
      tools: [],
    };
  }

  private handleAuthenticationPhase(_utterance: string): TurnResult {
    return {
      type: 'respond',
      provider: 'gpt-4o',
      pipelineMode: 'modular',
      latencyBudget: 500,
      responseInstruction: 'Verify the OTP code. If correct, confirm identity verified and resume their request.',
      tools: ['verifyOTP'],
    };
  }

  /**
   * Intent detection phase — this is where we decide the pipeline mode
   * for the rest of the call (or until the intent changes).
   */
  private handleIntentDetection(utterance: string): TurnResult {
    // Always use GPT-4o for fast intent classification (modular pipeline)
    return {
      type: 'classify_intent',
      provider: 'gpt-4o',
      pipelineMode: 'modular',
      latencyBudget: this.routingConfig.latencyBudgets.intentClassification,
      utterance,
      onClassified: (intent: Intent) => this.onIntentClassified(intent),
    };
  }

  /**
   * Called after intent is classified. Sets up the routing for the flow.
   * This is the KEY decision point — modular vs speech-to-speech.
   */
  onIntentClassified(intent: Intent): TurnResult {
    this.state.currentIntent = intent;
    this.state.phase = 'flow_execution';

    const decision = routeIntent(intent, this.routingConfig);
    this.state.activePipeline = decision.pipelineMode;
    this.state.activeProvider = decision.provider;

    this.logger.info({
      intent,
      provider: decision.provider,
      pipeline: decision.pipelineMode,
      complianceGates: decision.complianceGatesActive,
      costPerMin: decision.estimatedCostPerMin,
    }, 'Intent routed');

    // Auth check
    const requiredAuth = INTENT_AUTH_REQUIREMENTS[intent];
    if (this.state.authTier < requiredAuth) {
      this.state.phase = 'authentication';
      return {
        type: 'respond',
        provider: 'gpt-4o',
        pipelineMode: 'modular', // Auth always modular
        latencyBudget: 500,
        responseInstruction: `Caller needs auth tier ${requiredAuth}, currently at ${this.state.authTier}. Explain verification is needed and initiate OTP.`,
        tools: ['sendOTP'],
      };
    }

    // Human escalation check
    const threshold = HUMAN_ESCALATION_THRESHOLDS[intent];
    if (threshold === 0) {
      return this.escalateToHuman(`${intent} always requires human review`);
    }

    // If Grok-eligible, switch to speech-to-speech pipeline
    if (decision.pipelineMode === 'speech-to-speech') {
      return {
        type: 'switch_pipeline',
        pipelineMode: 'speech-to-speech',
        provider: 'grok-voice',
        grokConfig: this.buildGrokConfig(intent),
        responseInstruction: `Continuing conversation via Grok speech-to-speech for ${intent}`,
      };
    }

    // Modular pipeline — continue with Claude or GPT-4o
    const tools = this.getToolsForModel(this.state.model, intent);
    return {
      type: 'respond',
      provider: decision.provider,
      pipelineMode: 'modular',
      latencyBudget: decision.latencyBudget,
      responseInstruction: `Handle ${this.state.model} ${intent} flow. Auth tier: ${this.state.authTier}. State: ${JSON.stringify(this.state.flowState)}`,
      tools,
    };
  }

  private handleFlowExecution(utterance: string): TurnResult {
    if (!this.state.currentIntent) {
      this.state.phase = 'intent_detection';
      return this.handleIntentDetection(utterance);
    }

    const decision = routeIntent(this.state.currentIntent, this.routingConfig);
    const tools = this.getToolsForModel(this.state.model, this.state.currentIntent);

    // Check if amount mentioned triggers human escalation
    const amountMatch = utterance.match(/\$?([\d,]+(?:\.\d{2})?)/);
    if (amountMatch) {
      const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
      const threshold = HUMAN_ESCALATION_THRESHOLDS[this.state.currentIntent];
      if (threshold !== undefined && amount > threshold) {
        return this.escalateToHuman(
          `Transaction amount $${amount.toLocaleString()} exceeds threshold $${threshold.toLocaleString()} for ${this.state.currentIntent}`
        );
      }
    }

    return {
      type: 'respond',
      provider: decision.provider,
      pipelineMode: decision.pipelineMode,
      latencyBudget: decision.latencyBudget,
      responseInstruction: `Continue ${this.state.model} ${this.state.currentIntent} flow. Turn ${this.state.turnCount}. State: ${JSON.stringify(this.state.flowState)}`,
      tools,
    };
  }

  private handleConfirmation(utterance: string): TurnResult {
    const lower = utterance.toLowerCase();
    const affirm = ['yes', 'yeah', 'correct', 'confirmed', 'go ahead', 'proceed', 'do it'];
    const deny = ['no', 'nope', 'wait', 'cancel', 'hold on', 'not yet', 'stop'];

    if (affirm.some(w => lower.includes(w))) {
      // Execution ALWAYS goes through Claude on modular pipeline
      return {
        type: 'respond',
        provider: 'claude',
        pipelineMode: 'modular',
        latencyBudget: 800,
        responseInstruction: 'Customer confirmed. Execute the pending action and provide confirmation.',
        tools: this.state.pendingActions,
      };
    }

    if (deny.some(w => lower.includes(w))) {
      this.state.phase = 'flow_execution';
      return {
        type: 'respond',
        provider: 'gpt-4o',
        pipelineMode: 'modular',
        latencyBudget: 500,
        responseInstruction: 'Customer did not confirm. Ask what they\'d like to change.',
        tools: [],
      };
    }

    return {
      type: 'respond',
      provider: 'gpt-4o',
      pipelineMode: 'modular',
      latencyBudget: 300,
      responseInstruction: 'Ambiguous response. Ask: "Just to make sure — would you like me to go ahead?"',
      tools: [],
    };
  }

  // ==========================================================================
  // Compliance Trigger Handling
  // ==========================================================================

  private handleComplianceTrigger(trigger: TranscriptTrigger): TurnResult {
    if (trigger.type === 'opt_out') {
      this.state.phase = 'ended';
      this.state.escalated = true;
      this.state.escalationReason = 'opt_out';
      return {
        type: 'opt_out',
        responseText: `I understand. I'm removing your number from our call list right now. You won't receive any further automated calls. Is there anything else before I go?`,
      };
    }

    if (trigger.type === 'human_handoff') {
      return this.escalateToHuman('Customer requested human agent');
    }

    return {
      type: 'respond',
      provider: 'gpt-4o',
      pipelineMode: 'modular',
      latencyBudget: 300,
      responseInstruction: 'Continue normally.',
      tools: [],
    };
  }

  private escalateToHuman(reason: string): TurnResult {
    this.state.phase = 'escalation';
    this.state.escalated = true;
    this.state.escalationReason = reason;
    this.logger.info({ reason }, 'Escalating to human');

    return {
      type: 'escalate',
      reason,
      context: this.buildHandoffContext(),
      responseText: 'Of course! Let me connect you with a specialist right now. I\'m passing along everything we\'ve discussed so you won\'t need to repeat anything.',
    };
  }

  // ==========================================================================
  // Grok Voice Configuration Builder
  // ==========================================================================

  /**
   * Build Grok Voice Agent API configuration for speech-to-speech mode.
   * This creates the system prompt and tool definitions that get sent
   * to Grok's realtime endpoint.
   */
  private buildGrokConfig(intent: Intent): GrokVoiceConfig {
    const modelPrompts: Partial<Record<CalcModel, string>> = {
      DMC: `You are a voice assistant for DMC Banking. Professional, warm, concise. Help with account inquiries and general banking questions.`,
      CONSTITUTIONAL_TENDER: `You are a voice assistant for Constitutional Tender, a precious metals platform. Provide spot prices with timestamps. NEVER give investment advice. NEVER say "you should buy/sell" or "now is a good time." Always offer to connect with a specialist for transaction help.`,
      TILT: `You are a voice assistant for TILT Lending, a commercial real estate lender. Help with loan status inquiries. NEVER say "approved" or "guaranteed." All terms are "indicative" and "subject to underwriting."`,
      EUREKA: `You are a voice assistant for Eureka Settlement Services. Help with settlement status inquiries. NEVER represent that Eureka holds or custodies any assets.`,
      IFSE: `You are an internal voice assistant for IFSE Treasury operations. Provide data concisely. Staff context — no disclaimers needed.`,
    };

    // Tools available to Grok — read-only tools only for speech-to-speech
    const readOnlyTools = this.getReadOnlyTools(this.state.model);

    return {
      model: 'grok-3',
      voice: this.selectGrokVoice(this.state.model),
      systemPrompt: `${modelPrompts[this.state.model] ?? ''}\n\nIMPORTANT: You are an AI assistant. Disclose this at the start. Offer human handoff if asked. Never execute transactions — only provide information and quotes. Keep responses to 2-3 sentences.`,
      tools: readOnlyTools,
      temperature: 0.6,
      modalities: ['text', 'audio'],
    };
  }

  /** Select appropriate Grok voice per model */
  private selectGrokVoice(model: CalcModel): string {
    const voiceMap: Record<CalcModel, string> = {
      DMC: 'Sal',           // Warm, approachable for retail banking
      CONSTITUTIONAL_TENDER: 'Eve',   // Professional, measured for metals
      TILT: 'Mika',         // Confident for commercial lending
      MORTGAGE: 'Mika',     // Confident for residential lending
      REAL_ESTATE: 'Sal',   // Warm for buyer/seller coordination
      EUREKA: 'Eve',        // Professional for settlement
      LOAN_SERVICING: 'Sal', // Approachable for servicing calls
      IFSE: 'Ani',          // Direct for internal ops
      JACK: 'Sal',          // Warm, approachable for Calculus AI assistant
    };
    return voiceMap[model];
  }

  // ==========================================================================
  // Tool Resolution
  // ==========================================================================

  /** All tools for a model (read + write) — used in modular pipeline */
  private getToolsForModel(model: CalcModel, _intent: Intent | null): string[] {
    const toolMap: Record<CalcModel, string[]> = {
      DMC: [
        'nymbus_getAccountBalances', 'nymbus_getRecentTransactions',
        'nymbus_getCardStatus', 'nymbus_getPayees', 'nymbus_scheduleBillPay',
        'nymbus_getScheduledPayments',
        // HubSpot CRM (DMC primary CRM)
        'hubspot_getContact', 'hubspot_createContact', 'hubspot_updateContact',
        'hubspot_createDeal', 'hubspot_updateDeal', 'hubspot_createTicket',
        'hubspot_logCall', 'hubspot_createNote', 'hubspot_enrollInSequence',
        'crm_createTicket', 'crm_searchFAQ',
        'ifse_getCorridorStatus', 'ifse_getFXQuote', 'ifse_createWireRequest',
        'sanctions_screenBeneficiary',
      ],
      CONSTITUTIONAL_TENDER: [
        'pricing_getSpotPrice', 'pricing_lockPrice', 'pricing_getBidPrice',
        'wholesaler_checkAvailability', 'wholesaler_executeOrder',
        'custodian_getVaultOptions', 'custodian_getHoldings',
        'custodian_getEncumbranceStatus', 'custodian_requestLock',
        'custodian_validateTransferRoute', 'custodian_createTransferRequest',
        'custodian_getTransferFeeEstimate',
        'nymbus_getPaymentMethods', 'nymbus_getSettlementAccount',
        // GoHighLevel CRM (CT primary CRM)
        'ghl_getContact', 'ghl_createContact', 'ghl_updateContact',
        'ghl_createOpportunity', 'ghl_moveOpportunityStage',
        'ghl_addTag', 'ghl_bookAppointment', 'ghl_getAvailableSlots',
        'ghl_sendSMS', 'ghl_logCall', 'ghl_createNote',
        'ghl_addContactToWorkflow', 'ghl_createTask',
      ],
      TILT: [
        'tilt_calculateIndicativeDSCR', 'tilt_createLead',
        'tilt_getExistingBorrower', 'tilt_getLoanPrograms',
        'loanpro_getLoanDetails', 'loanpro_getPaymentSchedule',
        'loanpro_getPayoffQuote', 'loanpro_getEscrowBalance',
        // GoHighLevel CRM (TILT primary CRM — broker pipeline + speed-to-lead)
        'ghl_getContact', 'ghl_getContactByPhone', 'ghl_createContact', 'ghl_updateContact',
        'ghl_createOpportunity', 'ghl_moveOpportunityStage', 'ghl_getOpportunitiesByPipeline',
        'ghl_addTag', 'ghl_bookAppointment', 'ghl_getAvailableSlots',
        'ghl_sendSMS', 'ghl_sendEmail', 'ghl_logCall', 'ghl_createNote',
        'ghl_addContactToWorkflow', 'ghl_createTask',
      ],
      EUREKA: [
        'eureka_createSettlementFile', 'eureka_getSettlementStatus',
        'eureka_generateChecklist', 'eureka_getPartyRequirements',
        'custodian_getLockStatus', 'pricing_getBidPrice',
        // GoHighLevel CRM (Eureka primary CRM — settlement pipeline)
        'ghl_getContact', 'ghl_createContact', 'ghl_updateContact',
        'ghl_createOpportunity', 'ghl_moveOpportunityStage',
        'ghl_sendSMS', 'ghl_sendEmail', 'ghl_logCall', 'ghl_createNote',
        'ghl_addContactToWorkflow',
      ],
      IFSE: [
        'ifse_getFXExposure', 'ifse_getPendingWires',
        'ifse_getSettlementQueueStatus', 'ifse_generateReconReport',
        // HubSpot CRM (IFSE — internal ops tracking)
        'hubspot_createTicket', 'hubspot_getTicket', 'hubspot_createNote',
      ],
      MORTGAGE: [
        'mortgage_getRates', 'mortgage_getPrograms', 'mortgage_calculatePayment',
        'mortgage_startApplication', 'mortgage_saveProgress',
        'mortgage_sendDisclosures', 'mortgage_getDisclosureStatus',
        'mortgage_lockRate',
        // GoHighLevel CRM
        'ghl_getContact', 'ghl_createContact', 'ghl_updateContact',
        'ghl_createOpportunity', 'ghl_moveOpportunityStage',
        'ghl_bookAppointment', 'ghl_getAvailableSlots',
        'ghl_sendSMS', 'ghl_sendEmail', 'ghl_logCall', 'ghl_createNote',
        'ghl_addContactToWorkflow', 'ghl_createTask',
      ],
      REAL_ESTATE: [
        're_searchListings', 're_getPropertyDetails', 're_getComparables',
        're_submitOffer', 're_getOfferStatus', 're_counterOffer',
        're_scheduleShowing', 're_getAvailability', 're_cancelShowing',
        're_getTransactionStatus', 're_getDocumentChecklist', 're_getTimeline',
        're_requestDocument', 're_uploadStatus',
        // GoHighLevel CRM
        'ghl_getContact', 'ghl_createContact', 'ghl_updateContact',
        'ghl_createOpportunity', 'ghl_moveOpportunityStage',
        'ghl_bookAppointment', 'ghl_getAvailableSlots',
        'ghl_sendSMS', 'ghl_sendEmail', 'ghl_logCall', 'ghl_createNote',
        'ghl_addContactToWorkflow', 'ghl_createTask',
      ],
      LOAN_SERVICING: [
        'loanpro_getLoanDetails', 'loanpro_getPaymentHistory', 'loanpro_getNextPayment',
        'loanpro_makePayment', 'loanpro_setupAutoPay', 'loanpro_getPaymentMethods',
        'loanpro_getPayoffQuote', 'loanpro_emailPayoffStatement',
        'loanpro_getEscrowDetails', 'loanpro_getEscrowProjection',
        'loanpro_startModification', 'loanpro_getModificationStatus',
        'loanpro_getForbearanceOptions',
        // HubSpot CRM (existing borrower relationships)
        'hubspot_getContact', 'hubspot_updateContact',
        'hubspot_createTicket', 'hubspot_logCall', 'hubspot_createNote',
      ],
      JACK: [
        // Jack is Calculus AI assistant — no CRM or financial tools
        // Task dispatch and system status only
      ],
    };
    return toolMap[model] ?? [];
  }

  /** Read-only tools — safe for Grok speech-to-speech (no writes) */
  private getReadOnlyTools(model: CalcModel): GrokTool[] {
    const readOnlyMap: Record<CalcModel, GrokTool[]> = {
      DMC: [
        { name: 'getAccountBalances', description: 'Get customer account balances', parameters: { customerId: 'string' } },
        { name: 'getCardStatus', description: 'Get debit card status', parameters: { customerId: 'string' } },
        { name: 'getRecentTransactions', description: 'Get recent transactions', parameters: { customerId: 'string', limit: 'number' } },
        { name: 'searchFAQ', description: 'Search knowledge base', parameters: { query: 'string' } },
        // HubSpot read-only
        { name: 'hubspot_getContact', description: 'Look up customer in HubSpot CRM', parameters: { contactId: 'string' } },
        { name: 'hubspot_getTicketStatus', description: 'Check support ticket status', parameters: { ticketId: 'string' } },
      ],
      CONSTITUTIONAL_TENDER: [
        { name: 'getSpotPrice', description: 'Get current spot price for gold, silver, or platinum', parameters: { metal: 'string' } },
        { name: 'getVaultOptions', description: 'List available vault locations', parameters: { customerId: 'string' } },
        { name: 'getHoldings', description: 'Get customer vault holdings', parameters: { customerId: 'string' } },
        { name: 'getCustodyReceipt', description: 'Get custody receipt details', parameters: { customerId: 'string', holdingId: 'string' } },
        // GHL read-only
        { name: 'ghl_getContact', description: 'Look up customer in CRM', parameters: { contactId: 'string' } },
        { name: 'ghl_getAvailableSlots', description: 'Check available appointment times', parameters: { calendarId: 'string', date: 'string' } },
      ],
      TILT: [
        { name: 'getLoanDetails', description: 'Get loan details', parameters: { borrowerId: 'string' } },
        { name: 'getPaymentSchedule', description: 'Get payment schedule', parameters: { loanId: 'string' } },
        { name: 'getEscrowBalance', description: 'Get escrow balance', parameters: { loanId: 'string' } },
        // GHL read-only
        { name: 'ghl_getContact', description: 'Look up borrower/broker in CRM', parameters: { contactId: 'string' } },
        { name: 'ghl_getContactByPhone', description: 'Look up contact by phone number', parameters: { phone: 'string' } },
        { name: 'ghl_getAvailableSlots', description: 'Check available appointment times for loan officer', parameters: { calendarId: 'string', date: 'string' } },
        { name: 'ghl_getOpportunitiesByPipeline', description: 'Check deal status in pipeline', parameters: { pipelineId: 'string' } },
      ],
      EUREKA: [
        { name: 'getSettlementStatus', description: 'Get settlement file status', parameters: { fileId: 'string' } },
        // GHL read-only
        { name: 'ghl_getContact', description: 'Look up party in CRM', parameters: { contactId: 'string' } },
      ],
      IFSE: [
        { name: 'getFXExposure', description: 'Get FX exposure report', parameters: { date: 'string' } },
        { name: 'getPendingWires', description: 'List pending wires', parameters: {} },
        { name: 'getSettlementQueueStatus', description: 'Get settlement queue status', parameters: {} },
        { name: 'generateReconReport', description: 'Generate reconciliation report', parameters: { date: 'string' } },
      ],
      MORTGAGE: [
        { name: 'mortgage_getRates', description: 'Get current mortgage rates by program', parameters: {} },
        { name: 'mortgage_getPrograms', description: 'List available mortgage programs', parameters: {} },
        { name: 'mortgage_calculatePayment', description: 'Estimate monthly payment', parameters: { loanAmount: 'number', rate: 'number', termYears: 'number' } },
        { name: 'ghl_getContact', description: 'Look up borrower in CRM', parameters: { contactId: 'string' } },
        { name: 'ghl_getAvailableSlots', description: 'Check loan officer availability', parameters: { calendarId: 'string', date: 'string' } },
      ],
      REAL_ESTATE: [
        { name: 're_searchListings', description: 'Search active property listings', parameters: { location: 'string', priceMax: 'number', beds: 'number' } },
        { name: 're_getPropertyDetails', description: 'Get property details', parameters: { propertyId: 'string' } },
        { name: 're_getComparables', description: 'Get comparable sales', parameters: { propertyId: 'string' } },
        { name: 're_getAvailability', description: 'Check showing availability', parameters: { propertyId: 'string', date: 'string' } },
        { name: 'ghl_getContact', description: 'Look up client in CRM', parameters: { contactId: 'string' } },
      ],
      LOAN_SERVICING: [
        { name: 'loanpro_getLoanDetails', description: 'Get loan details and current balance', parameters: { borrowerId: 'string' } },
        { name: 'loanpro_getPaymentHistory', description: 'Get payment history', parameters: { loanId: 'string' } },
        { name: 'loanpro_getNextPayment', description: 'Get next payment details', parameters: { loanId: 'string' } },
        { name: 'loanpro_getEscrowDetails', description: 'Get escrow account breakdown', parameters: { loanId: 'string' } },
        { name: 'hubspot_getContact', description: 'Look up borrower in CRM', parameters: { contactId: 'string' } },
      ],
      JACK: [
        // Jack — Calculus AI assistant, no financial read-only tools
      ],
    };
    return readOnlyMap[model] ?? [];
  }

  // ==========================================================================
  // State Management
  // ==========================================================================

  setIntent(intent: Intent): void {
    this.state.currentIntent = intent;
    this.state.phase = 'flow_execution';
  }

  upgradeAuth(newTier: AuthTier): void {
    this.state.authTier = newTier;
    this.state.phase = 'flow_execution';
  }

  updateFlowState(updates: Record<string, unknown>): void {
    this.state.flowState = { ...this.state.flowState, ...updates };
  }

  moveToConfirmation(pendingActions: string[]): void {
    this.state.phase = 'confirmation';
    this.state.pendingActions = pendingActions;
  }

  getState(): Readonly<ConversationState> {
    return { ...this.state };
  }

  private buildHandoffContext(): Record<string, unknown> {
    return {
      conversationId: this.state.conversationId,
      model: this.state.model,
      intent: this.state.currentIntent,
      authTier: this.state.authTier,
      flowState: this.state.flowState,
      turnCount: this.state.turnCount,
      activePipeline: this.state.activePipeline,
    };
  }
}

// ============================================================================
// Turn Result Types (Updated with pipeline mode)
// ============================================================================

export type TurnResult =
  | {
      type: 'respond';
      provider: LLMProvider;
      pipelineMode: PipelineMode;
      latencyBudget: number;
      responseInstruction: string;
      tools: string[];
      metadata?: Record<string, unknown>;
    }
  | {
      type: 'classify_intent';
      provider: 'gpt-4o';
      pipelineMode: 'modular';
      latencyBudget: number;
      utterance: string;
      onClassified: (intent: Intent) => TurnResult;
    }
  | {
      type: 'switch_pipeline';
      pipelineMode: 'speech-to-speech';
      provider: 'grok-voice';
      grokConfig: GrokVoiceConfig;
      responseInstruction: string;
    }
  | {
      type: 'system_action';
      action: string;
      nextPhase: ConversationPhase;
    }
  | {
      type: 'escalate';
      reason: string;
      context: Record<string, unknown>;
      responseText: string;
    }
  | {
      type: 'opt_out';
      responseText: string;
    };

// ============================================================================
// Grok Voice Types
// ============================================================================

export interface GrokVoiceConfig {
  model: string;
  voice: string;
  systemPrompt: string;
  tools: GrokTool[];
  temperature: number;
  modalities: string[];
}

export interface GrokTool {
  name: string;
  description: string;
  parameters: Record<string, string>;
}
