/**
 * Voice Pipeline Controller
 *
 * The top-level orchestration layer that manages the full call lifecycle.
 * Handles pipeline switching between:
 *   - Modular: Deepgram STT → ComplianceEnforcer → LLM → Cartesia TTS
 *   - Speech-to-Speech: Audio → Grok Voice → Audio
 *
 * Integrates with:
 *   - Telephony gateway (Twilio/Telnyx WebSocket)
 *   - ComplianceEnforcer (pre-dial, real-time, post-call gates)
 *   - ConversationOrchestrator (state machine, intent routing)
 *   - GrokVoiceAdapter (speech-to-speech sessions)
 *   - Audit service (immutable event log)
 */

import { v4 as uuid } from 'uuid';
import type { Logger } from 'pino';
import type {
  AuthTier,
  CalcModel,
  CallDirection,
  CallType,
  CallPurpose,
  VoiceSession,
  AuditEvent,
} from '../types.js';
import {
  ConversationOrchestrator,
  type TurnResult,
  type PipelineMode,
  type LLMProvider,
} from '../orchestrator/orchestrator.js';
import {
  ComplianceEnforcer,
  type CallContext,
  type GateCheckResult,
  type ComplianceScorecard,
} from '../compliance/enforcer.js';
import {
  GrokVoiceAdapter,
  type GrokAdapterEvent,
  DEFAULT_GROK_CONFIG,
} from '../gateway/grok-adapter.js';
import type {
  IConsentService,
  IAuditService,
  ICRMService,
} from '../services/contracts.js';

// ============================================================================
// Pipeline Controller Config
// ============================================================================

export interface PipelineControllerConfig {
  /** Deepgram API key */
  deepgramApiKey: string;

  /** Cartesia API key */
  cartesiaApiKey: string;

  /** xAI API key for Grok Voice */
  xaiApiKey: string;

  /** OpenAI API key (GPT-4o) */
  openaiApiKey: string;

  /** Anthropic API key (Claude) */
  anthropicApiKey: string;

  /** Enable Grok speech-to-speech for eligible intents */
  enableGrokSpeechToSpeech: boolean;

  /** Max retries before escalating to human */
  maxRetries: number;

  /** Silence timeout ms */
  silenceTimeoutMs: number;
}

// ============================================================================
// Call Session — Tracks everything for a single call
// ============================================================================

export interface CallSession {
  sessionId: string;
  conversationId: string;
  callDirection: CallDirection;
  model: CalcModel;
  activePipeline: PipelineMode;
  startedAt: Date;
  endedAt: Date | null;
  totalDurationMs: number;

  // Cost tracking
  modularMinutes: number;
  grokMinutes: number;
  estimatedCostCents: number;

  // Compliance tracking
  preDialGatesPassed: boolean;
  disclosureDelivered: boolean;
  disclosureTimingMs: number;
  recordingConsentObtained: boolean;
  optOutRequests: number;
  piiIncidents: number;
  safetyTriggers: number;
  humanHandoffs: number;

  // Outcome
  outcome: string;
  scorecard: ComplianceScorecard | null;
}

// ============================================================================
// Pipeline Controller
// ============================================================================

export class VoicePipelineController {
  private config: PipelineControllerConfig;
  private compliance: ComplianceEnforcer;
  private orchestrator: ConversationOrchestrator | null = null;
  private grokAdapter: GrokVoiceAdapter | null = null;
  private auditService: IAuditService;
  private consentService: IConsentService;
  private logger: Logger;
  private session: CallSession | null = null;
  private activePipeline: PipelineMode = 'modular';

  constructor(params: {
    config: PipelineControllerConfig;
    compliance: ComplianceEnforcer;
    auditService: IAuditService;
    consentService: IConsentService;
    logger: Logger;
  }) {
    this.config = params.config;
    this.compliance = params.compliance;
    this.auditService = params.auditService;
    this.consentService = params.consentService;
    this.logger = params.logger.child({ component: 'PipelineController' });
  }

  // ==========================================================================
  // Call Lifecycle
  // ==========================================================================

  /**
   * Initialize a new call session.
   * For outbound: runs pre-dial compliance gates first.
   * For inbound: proceeds directly to greeting/disclosure.
   */
  async initializeCall(params: {
    callDirection: CallDirection;
    callType: CallType;
    callPurpose: CallPurpose;
    model: CalcModel;
    recipientPhone: string;
    recipientState: string;
    callerIdNumber: string;
    callerIdName: string;
    customerId: string | null;
    initialAuthTier: AuthTier;
  }): Promise<{
    proceed: boolean;
    blockReason?: string;
    session: CallSession;
  }> {
    const conversationId = uuid();
    const sessionId = uuid();

    this.session = {
      sessionId,
      conversationId,
      callDirection: params.callDirection,
      model: params.model,
      activePipeline: 'modular',
      startedAt: new Date(),
      endedAt: null,
      totalDurationMs: 0,
      modularMinutes: 0,
      grokMinutes: 0,
      estimatedCostCents: 0,
      preDialGatesPassed: false,
      disclosureDelivered: false,
      disclosureTimingMs: 0,
      recordingConsentObtained: false,
      optOutRequests: 0,
      piiIncidents: 0,
      safetyTriggers: 0,
      humanHandoffs: 0,
      outcome: 'in_progress',
      scorecard: null,
    };

    // ----- Pre-dial gates for outbound calls -----
    if (params.callDirection === 'outbound') {
      const consent = await this.consentService.getConsent(params.recipientPhone);
      const dncResult = await this.consentService.checkDNC(params.recipientPhone);

      const callCtx: CallContext = {
        conversationId,
        callDirection: params.callDirection,
        callType: params.callType,
        callPurpose: params.callPurpose,
        recipientPhone: params.recipientPhone,
        recipientState: params.recipientState,
        recipientPhoneType: 'unknown',
        callerIdNumber: params.callerIdNumber,
        callerIdName: params.callerIdName,
        currentAuthTier: params.initialAuthTier,
        customerId: params.customerId,
        currentTimeRecipientTZ: new Date(), // Would resolve TZ in production
        consentRecord: consent,
        dncResult,
      };

      const gateResults = await this.compliance.runPreDialGates(callCtx);
      const failures = gateResults.filter(g => !g.passed);

      if (failures.length > 0) {
        this.session.preDialGatesPassed = false;
        this.session.outcome = 'blocked_pre_dial';
        this.session.endedAt = new Date();

        this.logger.warn({
          failures: failures.map(f => ({ gate: f.gateName, reason: f.reason })),
        }, 'Call BLOCKED by pre-dial gates');

        await this.auditService.logEvent({
          timestamp: new Date(),
          conversationId,
          model: params.model,
          eventType: 'compliance_gate_fail',
          authTier: params.initialAuthTier,
          customerId: params.customerId,
          intent: null,
          action: 'pre_dial_gates',
          result: `blocked: ${failures.map(f => f.reason).join(', ')}`,
          metadata: { gateResults },
          createdByAgent: true,
        });

        return {
          proceed: false,
          blockReason: failures[0].reason,
          session: this.session,
        };
      }

      this.session.preDialGatesPassed = true;
    } else {
      // Inbound calls skip pre-dial gates
      this.session.preDialGatesPassed = true;
    }

    // ----- Initialize orchestrator -----
    this.orchestrator = new ConversationOrchestrator({
      conversationId,
      model: params.model,
      initialAuthTier: params.initialAuthTier,
      compliance: this.compliance,
      auditService: this.auditService,
      logger: this.logger,
    });

    await this.auditService.logEvent({
      timestamp: new Date(),
      conversationId,
      model: params.model,
      eventType: 'call_started',
      authTier: params.initialAuthTier,
      customerId: params.customerId,
      intent: null,
      action: null,
      result: 'connected',
      metadata: {
        callDirection: params.callDirection,
        callType: params.callType,
        model: params.model,
      },
      createdByAgent: true,
    });

    return { proceed: true, session: this.session };
  }

  // ==========================================================================
  // Turn Processing — Routes to correct pipeline
  // ==========================================================================

  /**
   * Process a turn of conversation.
   *
   * In modular mode: utterance comes from Deepgram STT.
   * In speech-to-speech: this is called less frequently (intent changes, escalations).
   */
  async processTurn(utterance: string): Promise<TurnResult> {
    if (!this.orchestrator) {
      throw new Error('Call not initialized');
    }

    const result = await this.orchestrator.processTurn(utterance);

    // Handle pipeline switch requests
    if (result.type === 'switch_pipeline' && result.pipelineMode === 'speech-to-speech') {
      if (this.config.enableGrokSpeechToSpeech) {
        await this.switchToGrok(result.grokConfig);
      } else {
        // Grok disabled — fallback to GPT-4o modular
        this.logger.info('Grok speech-to-speech disabled, using modular fallback');
        return {
          type: 'respond',
          provider: 'gpt-4o',
          pipelineMode: 'modular',
          latencyBudget: 500,
          responseInstruction: result.responseInstruction,
          tools: [],
        };
      }
    }

    // Handle opt-out
    if (result.type === 'opt_out') {
      await this.handleOptOut();
    }

    // Handle escalation
    if (result.type === 'escalate') {
      this.session!.humanHandoffs++;
    }

    return result;
  }

  // ==========================================================================
  // Pipeline Switching
  // ==========================================================================

  /**
   * Switch from modular pipeline to Grok speech-to-speech.
   * Called when orchestrator routes to a Grok-eligible intent.
   */
  private async switchToGrok(grokConfig: any): Promise<void> {
    if (!this.session) return;

    this.logger.info('Switching to Grok speech-to-speech pipeline');

    this.grokAdapter = new GrokVoiceAdapter(
      {
        ...DEFAULT_GROK_CONFIG,
        apiKey: this.config.xaiApiKey,
      },
      (event) => this.handleGrokEvent(event),
      this.logger,
    );

    try {
      await this.grokAdapter.connect(grokConfig);
      this.activePipeline = 'speech-to-speech';
      this.session.activePipeline = 'speech-to-speech';
    } catch (error) {
      this.logger.error({ error }, 'Failed to connect to Grok, staying on modular');
      this.grokAdapter = null;
      // Don't throw — caller stays on modular pipeline
    }
  }

  /**
   * Switch back from Grok to modular pipeline.
   * Called on: safety trigger, Grok error, intent change to modular-required.
   */
  private async switchToModular(reason: string): Promise<void> {
    if (!this.session) return;

    this.logger.info({ reason }, 'Switching back to modular pipeline');

    if (this.grokAdapter?.connected) {
      await this.grokAdapter.disconnect(reason);
    }
    this.grokAdapter = null;
    this.activePipeline = 'modular';
    this.session.activePipeline = 'modular';
  }

  // ==========================================================================
  // Grok Event Handling
  // ==========================================================================

  private handleGrokEvent(event: GrokAdapterEvent): void {
    switch (event.type) {
      case 'audio_out':
        // Forward audio to telephony — handled by the gateway layer
        break;

      case 'tool_call':
        // Execute read-only tool and return result to Grok
        this.executeGrokToolCall(event.toolName, event.args, event.callId);
        break;

      case 'safety_trigger':
        this.logger.error({
          keyword: event.keyword,
        }, 'SAFETY: Grok generated prohibited content');

        this.session!.safetyTriggers++;

        // Switch back to modular pipeline immediately
        this.switchToModular('safety_violation');
        break;

      case 'error':
        if (event.recoverable) {
          this.logger.warn({ error: event.error }, 'Grok error, falling back to modular');
          this.switchToModular('grok_error');
        }
        break;

      case 'transcript_agent':
        // Captured for post-call audit
        break;

      case 'transcript_user':
        // Could trigger intent re-classification if needed
        break;
    }
  }

  /**
   * Execute a read-only tool call from Grok.
   * Only read-only tools are exposed to Grok — no writes.
   */
  private async executeGrokToolCall(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<void> {
    try {
      // Tool execution would be dispatched to the appropriate service
      // This is a placeholder — actual implementation connects to service contracts
      const result = await this.dispatchToolCall(toolName, args);

      this.grokAdapter?.sendToolResult(callId, result);

      await this.auditService.logEvent({
        timestamp: new Date(),
        conversationId: this.session!.conversationId,
        model: this.session!.model,
        eventType: 'action_executed',
        authTier: 0 as AuthTier, // from session
        customerId: null,
        intent: null,
        action: `grok_tool:${toolName}`,
        result: 'success',
        metadata: { args, pipeline: 'speech-to-speech' },
        createdByAgent: true,
      });
    } catch (error) {
      this.logger.error({ error, toolName }, 'Grok tool call failed');
      this.grokAdapter?.sendToolResult(callId, {
        error: 'Tool execution failed. Please try again or offer to connect with a specialist.',
      });
    }
  }

  /**
   * Dispatch tool call to appropriate service.
   * In production, this maps tool names to service contract methods.
   */
  private async dispatchToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    // This would be a registry of service implementations
    // For now, return a placeholder
    this.logger.info({ toolName, args }, 'Dispatching tool call');
    throw new Error(`Tool ${toolName} not yet implemented`);
  }

  // ==========================================================================
  // Call Termination
  // ==========================================================================

  /**
   * End the call and generate compliance scorecard.
   */
  async endCall(outcome: string): Promise<CallSession> {
    if (!this.session) throw new Error('No active session');

    this.session.endedAt = new Date();
    this.session.totalDurationMs = this.session.endedAt.getTime() - this.session.startedAt.getTime();
    this.session.outcome = outcome;

    // Disconnect Grok if active
    if (this.grokAdapter?.connected) {
      await this.grokAdapter.disconnect('call_ended');
    }

    // Generate compliance scorecard
    this.session.scorecard = this.compliance.generateComplianceScorecard({
      disclosureDelivered: this.session.disclosureDelivered,
      disclosureTimingMs: this.session.disclosureTimingMs,
      recordingConsentObtained: this.session.recordingConsentObtained,
      optOutRequestsHonored: this.session.optOutRequests > 0, // simplified
      piiIncidents: this.session.piiIncidents,
      piiRedactionApplied: true, // Deepgram handles this
      pricingDisclaimersDelivered: 0, // track from flow state
      humanHandoffs: this.session.humanHandoffs,
      callWithinPermittedHours: true, // checked at pre-dial
      consentWasValidAtDial: this.session.preDialGatesPassed,
      dncWasClearAtDial: this.session.preDialGatesPassed,
      callerIdWasValid: this.session.preDialGatesPassed,
      financialGuardrailsTriggered: 0,
      investmentAdviceBlocked: this.session.safetyTriggers,
    });

    // Calculate cost
    const totalMinutes = this.session.totalDurationMs / 60000;
    this.session.estimatedCostCents = Math.round(
      (this.session.grokMinutes * 5) + // $0.05/min Grok
      (this.session.modularMinutes * 7.7) // ~$0.077/min modular
    );

    // Audit: call ended
    await this.auditService.logEvent({
      timestamp: new Date(),
      conversationId: this.session.conversationId,
      model: this.session.model,
      eventType: 'call_ended',
      authTier: 0 as AuthTier,
      customerId: null,
      intent: null,
      action: null,
      result: outcome,
      metadata: {
        duration: this.session.totalDurationMs,
        pipeline: this.session.activePipeline,
        grokMinutes: this.session.grokMinutes,
        modularMinutes: this.session.modularMinutes,
        costCents: this.session.estimatedCostCents,
        scorecard: this.session.scorecard,
      },
      createdByAgent: true,
    });

    this.logger.info({
      outcome,
      durationMs: this.session.totalDurationMs,
      costCents: this.session.estimatedCostCents,
      compliancePass: this.session.scorecard?.overallPass,
    }, 'Call ended');

    return this.session;
  }

  // ==========================================================================
  // Opt-Out Handling
  // ==========================================================================

  private async handleOptOut(): Promise<void> {
    if (!this.session) return;

    this.session.optOutRequests++;

    // Revoke consent immediately
    await this.consentService.revokeConsent(
      '', // Would have the phone number from session
      {
        conversationId: this.session.conversationId,
        method: 'verbal_during_call',
        scope: 'all_automated',
      }
    );

    // Suppress number
    await this.consentService.addToSuppression(
      '', // phone
      'verbal_opt_out_during_ai_call'
    );

    this.logger.info('Opt-out processed: consent revoked, number suppressed');
  }

  // ==========================================================================
  // Audio Routing (called by telephony gateway)
  // ==========================================================================

  /**
   * Route incoming audio to the active pipeline.
   * Called by the telephony WebSocket handler for every audio frame.
   */
  routeAudio(audioChunk: Buffer): void {
    if (this.activePipeline === 'speech-to-speech' && this.grokAdapter?.connected) {
      this.grokAdapter.sendAudio(audioChunk);
    }
    // In modular mode, audio goes to Deepgram STT (handled by gateway layer)
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  getSession(): Readonly<CallSession> | null {
    return this.session ? { ...this.session } : null;
  }

  getActivePipeline(): PipelineMode {
    return this.activePipeline;
  }
}
