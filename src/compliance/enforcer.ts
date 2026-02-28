/**
 * ComplianceEnforcer — Gate Execution Engine
 *
 * Non-bypassable compliance pipeline. Every outbound call passes through
 * pre-dial gates. Every active call runs real-time monitors. Every
 * completed call gets a post-call audit.
 *
 * Maps to: Orchestra_DSL_ComplianceEnforcer_v1.yaml
 */

import { parsePhoneNumber } from 'libphonenumber-js';
import { v4 as uuid } from 'uuid';
import type {
  AuthTier,
  CallDirection,
  CallPurpose,
  CallType,
  ComplianceGateResult,
  AuditEvent,
} from '../types.js';
import type { IConsentService, IAuditService, ConsentRecord, DNCResult } from '../services/contracts.js';
import type { Logger } from 'pino';

// ============================================================================
// Configuration
// ============================================================================

export interface ComplianceConfig {
  /** States requiring two-party recording consent */
  twoPartyConsentStates: string[];

  /** States with AI-specific disclosure requirements */
  aiDisclosureStates: string[];

  /** Opt-out keywords (hard stop) */
  optOutKeywords: string[];

  /** Human handoff keywords */
  humanHandoffKeywords: string[];

  /** Fuzzy match threshold for opt-out detection (0-1) */
  fuzzyThreshold: number;

  /** Federal call hours */
  callHours: { earliest: number; latest: number };

  /** Financial guardrail thresholds */
  financial: {
    priceStalenessThresholdSeconds: number;
    requireHumanForTransactionsAbove: number;
    requireTimestampOnPricing: boolean;
  };

  /** Enforcement mode */
  enforcement: 'strict' | 'advisory';
}

export const DEFAULT_COMPLIANCE_CONFIG: ComplianceConfig = {
  twoPartyConsentStates: [
    'CA', 'CT', 'FL', 'IL', 'MA', 'MD', 'MI', 'MT', 'NH', 'PA', 'WA',
  ],
  aiDisclosureStates: ['UT', 'CA', 'CO', 'TX'],
  optOutKeywords: [
    'stop', 'quit', 'cancel', 'unsubscribe', 'do not call',
    'remove me', 'opt out', 'take me off', 'no more calls', 'don\x27t call', 'don\x27t want you to call', 'call me anymore',
  ],
  humanHandoffKeywords: [
    'human', 'agent', 'representative', 'real person',
    'talk to someone', 'supervisor', 'manager',
  ],
  fuzzyThreshold: 0.85,
  callHours: { earliest: 8, latest: 21 },
  financial: {
    priceStalenessThresholdSeconds: 300,
    requireHumanForTransactionsAbove: 10_000,
    requireTimestampOnPricing: true,
  },
  enforcement: 'strict',
};

// ============================================================================
// Gate Results
// ============================================================================

export interface GateCheckResult {
  gateId: string;
  gateName: string;
  passed: boolean;
  reason?: string;
  action?: GateAction;
  timestamp: Date;
}

export type GateAction =
  | { type: 'block_call'; reason: string }
  | { type: 'reschedule'; nextWindow: Date }
  | { type: 'route_to_human'; reason: string; priority: string }
  | { type: 'inject_disclosure'; template: string }
  | { type: 'prompt_recording_consent' }
  | { type: 'process_opt_out'; phone: string }
  | { type: 'human_handoff'; reason: string }
  | { type: 'block_response'; replacement: string }
  | { type: 'append_disclaimer'; text: string }
  | { type: 'log_only'; message: string };

// ============================================================================
// Call Context — passed to every gate
// ============================================================================

export interface CallContext {
  conversationId: string;
  callDirection: CallDirection;
  callType: CallType;
  callPurpose: CallPurpose;
  recipientPhone: string;
  recipientState: string;
  recipientPhoneType: 'mobile' | 'landline' | 'voip' | 'unknown';
  callerIdNumber: string;
  callerIdName: string;
  currentAuthTier: AuthTier;
  customerId: string | null;
  currentTimeRecipientTZ: Date;
  consentRecord: ConsentRecord | null;
  dncResult: DNCResult | null;
}

// ============================================================================
// ComplianceEnforcer — Main Class
// ============================================================================

export class ComplianceEnforcer {
  private config: ComplianceConfig;
  private consentService: IConsentService;
  private auditService: IAuditService;
  private logger: Logger;

  constructor(
    config: ComplianceConfig,
    consentService: IConsentService,
    auditService: IAuditService,
    logger: Logger,
  ) {
    this.config = config;
    this.consentService = consentService;
    this.auditService = auditService;
    this.logger = logger.child({ component: 'ComplianceEnforcer' });
  }

  // ==========================================================================
  // PRE-DIAL GATES (outbound only)
  // ==========================================================================

  /**
   * Run all pre-dial compliance checks. Returns array of gate results.
   * If ANY gate fails in strict mode, the call MUST NOT proceed.
   */
  async runPreDialGates(ctx: CallContext): Promise<GateCheckResult[]> {
    if (ctx.callDirection !== 'outbound') {
      return []; // Pre-dial gates only apply to outbound
    }

    const results: GateCheckResult[] = [];

    // Gate 1: Consent Verification
    results.push(await this.checkConsent(ctx));

    // Gate 2: DNC & Suppression
    results.push(await this.checkDNC(ctx));

    // Gate 3: Time-of-Day
    results.push(this.checkTimeOfDay(ctx));

    // Gate 4: Caller ID Integrity
    results.push(this.checkCallerId(ctx));

    // Log all results
    for (const result of results) {
      await this.auditService.logEvent({
        timestamp: result.timestamp,
        conversationId: ctx.conversationId,
        model: 'DMC' as any, // Will be overridden by caller
        eventType: result.passed ? 'compliance_gate_pass' : 'compliance_gate_fail',
        authTier: ctx.currentAuthTier,
        customerId: ctx.customerId,
        intent: null,
        action: result.gateId,
        result: result.passed ? 'pass' : `fail: ${result.reason}`,
        metadata: { gateName: result.gateName },
        createdByAgent: true,
      });
    }

    // In strict mode, any failure blocks the call
    if (this.config.enforcement === 'strict') {
      const failures = results.filter(r => !r.passed);
      if (failures.length > 0) {
        this.logger.warn(
          { conversationId: ctx.conversationId, failures },
          'Pre-dial gates BLOCKED call'
        );
      }
    }

    return results;
  }

  /** Gate 1: Consent Verification */
  private async checkConsent(ctx: CallContext): Promise<GateCheckResult> {
    const now = new Date();
    const consent = ctx.consentRecord;

    // No consent record at all
    if (!consent) {
      return {
        gateId: 'consent_gate',
        gateName: 'Consent Verification',
        passed: false,
        reason: 'No consent record found for this number',
        action: { type: 'block_call', reason: 'NO_CONSENT' },
        timestamp: now,
      };
    }

    // Check revocation
    if (consent.revocationHistory.length > 0 && !consent.reOptedInAfterLastRevocation) {
      return {
        gateId: 'consent_gate',
        gateName: 'Consent Verification',
        passed: false,
        reason: 'Consent was previously revoked and not re-established',
        action: { type: 'block_call', reason: 'CONSENT_REVOKED' },
        timestamp: now,
      };
    }

    // Telemarketing requires written AI consent
    if (ctx.callPurpose === 'telemarketing') {
      if (!consent.aiWrittenConsent || !consent.aiConsentTimestamp) {
        return {
          gateId: 'consent_gate',
          gateName: 'Consent Verification',
          passed: false,
          reason: 'No written AI consent for telemarketing',
          action: { type: 'block_call', reason: 'NO_WRITTEN_AI_CONSENT' },
          timestamp: now,
        };
      }

      // Check consent age (max 365 days)
      const consentAge = now.getTime() - consent.aiConsentTimestamp.getTime();
      const maxAge = 365 * 24 * 60 * 60 * 1000;
      if (consentAge > maxAge) {
        return {
          gateId: 'consent_gate',
          gateName: 'Consent Verification',
          passed: false,
          reason: 'Written AI consent expired (>365 days)',
          action: { type: 'block_call', reason: 'CONSENT_EXPIRED' },
          timestamp: now,
        };
      }

      // Verify consent is to this seller
      if (consent.aiConsentSeller !== 'Constitutional Tender') {
        return {
          gateId: 'consent_gate',
          gateName: 'Consent Verification',
          passed: false,
          reason: 'Consent was given to a different seller',
          action: { type: 'block_call', reason: 'WRONG_SELLER' },
          timestamp: now,
        };
      }
    }

    // Informational requires at least automated consent
    if (ctx.callPurpose === 'informational') {
      if (!consent.automatedConsent) {
        return {
          gateId: 'consent_gate',
          gateName: 'Consent Verification',
          passed: false,
          reason: 'No automated call consent for informational calls',
          action: { type: 'block_call', reason: 'NO_AUTOMATED_CONSENT' },
          timestamp: now,
        };
      }
    }

    // Callbacks require recent callback request
    if (ctx.callType === 'callback') {
      if (!consent.callbackRequested || !consent.callbackRequestedAt) {
        return {
          gateId: 'consent_gate',
          gateName: 'Consent Verification',
          passed: false,
          reason: 'No callback request on file',
          action: { type: 'block_call', reason: 'NO_CALLBACK_REQUEST' },
          timestamp: now,
        };
      }

      const callbackAge = now.getTime() - consent.callbackRequestedAt.getTime();
      const maxCallbackAge = 72 * 60 * 60 * 1000; // 72 hours
      if (callbackAge > maxCallbackAge) {
        return {
          gateId: 'consent_gate',
          gateName: 'Consent Verification',
          passed: false,
          reason: 'Callback request expired (>72 hours)',
          action: { type: 'block_call', reason: 'CALLBACK_EXPIRED' },
          timestamp: now,
        };
      }
    }

    return {
      gateId: 'consent_gate',
      gateName: 'Consent Verification',
      passed: true,
      timestamp: now,
    };
  }

  /** Gate 2: DNC & Suppression */
  private async checkDNC(ctx: CallContext): Promise<GateCheckResult> {
    const now = new Date();
    let dncResult = ctx.dncResult;

    if (!dncResult) {
      dncResult = await this.consentService.checkDNC(ctx.recipientPhone);
    }

    if (dncResult.onNationalDNC) {
      return {
        gateId: 'dnc_gate',
        gateName: 'DNC & Suppression Check',
        passed: false,
        reason: 'Number on National DNC Registry',
        action: { type: 'block_call', reason: 'NATIONAL_DNC' },
        timestamp: now,
      };
    }

    if (dncResult.onStateDNC) {
      return {
        gateId: 'dnc_gate',
        gateName: 'DNC & Suppression Check',
        passed: false,
        reason: 'Number on state DNC registry',
        action: { type: 'block_call', reason: 'STATE_DNC' },
        timestamp: now,
      };
    }

    if (dncResult.onInternalSuppression) {
      return {
        gateId: 'dnc_gate',
        gateName: 'DNC & Suppression Check',
        passed: false,
        reason: 'Number on internal suppression list',
        action: { type: 'block_call', reason: 'INTERNAL_SUPPRESSION' },
        timestamp: now,
      };
    }

    if (dncResult.numberReassigned) {
      // Number was reassigned after consent was captured
      const consent = ctx.consentRecord;
      if (
        consent?.automatedConsentTimestamp &&
        dncResult.reassignedDate &&
        consent.automatedConsentTimestamp < dncResult.reassignedDate
      ) {
        return {
          gateId: 'dnc_gate',
          gateName: 'DNC & Suppression Check',
          passed: false,
          reason: 'Number reassigned after consent was obtained',
          action: { type: 'block_call', reason: 'NUMBER_REASSIGNED' },
          timestamp: now,
        };
      }
    }

    return {
      gateId: 'dnc_gate',
      gateName: 'DNC & Suppression Check',
      passed: true,
      timestamp: now,
    };
  }

  /** Gate 3: Time-of-Day */
  checkTimeOfDay(ctx: CallContext): GateCheckResult {
    const now = new Date();
    const hour = ctx.currentTimeRecipientTZ.getHours();

    if (hour < this.config.callHours.earliest || hour >= this.config.callHours.latest) {
      return {
        gateId: 'time_gate',
        gateName: 'Calling Hours Enforcement',
        passed: false,
        reason: `Outside permitted hours (${this.config.callHours.earliest}:00-${this.config.callHours.latest}:00 recipient local)`,
        action: { type: 'reschedule', nextWindow: this.getNextValidWindow(ctx) },
        timestamp: now,
      };
    }

    return {
      gateId: 'time_gate',
      gateName: 'Calling Hours Enforcement',
      passed: true,
      timestamp: now,
    };
  }

  /** Gate 4: Caller ID Integrity */
  checkCallerId(ctx: CallContext): GateCheckResult {
    const now = new Date();

    if (!ctx.callerIdNumber || !ctx.callerIdName) {
      return {
        gateId: 'caller_id_gate',
        gateName: 'Caller ID Integrity',
        passed: false,
        reason: 'Caller ID not configured',
        action: { type: 'block_call', reason: 'CALLERID_MISSING' },
        timestamp: now,
      };
    }

    // Validate phone number format
    try {
      const parsed = parsePhoneNumber(ctx.callerIdNumber, 'US');
      if (!parsed?.isValid()) {
        return {
          gateId: 'caller_id_gate',
          gateName: 'Caller ID Integrity',
          passed: false,
          reason: 'Caller ID number is invalid',
          action: { type: 'block_call', reason: 'CALLERID_INVALID' },
          timestamp: now,
        };
      }
    } catch {
      return {
        gateId: 'caller_id_gate',
        gateName: 'Caller ID Integrity',
        passed: false,
        reason: 'Caller ID number failed validation',
        action: { type: 'block_call', reason: 'CALLERID_PARSE_ERROR' },
        timestamp: now,
      };
    }

    return {
      gateId: 'caller_id_gate',
      gateName: 'Caller ID Integrity',
      passed: true,
      timestamp: now,
    };
  }

  // ==========================================================================
  // CALL-START GATES (inbound + outbound)
  // ==========================================================================

  /** Gate 5: Determine which AI disclosure template to use */
  getDisclosureTemplate(ctx: CallContext): string {
    if (ctx.callDirection === 'inbound') {
      return DISCLOSURE_TEMPLATES.inbound_default;
    }

    if (ctx.callType === 'callback') {
      return DISCLOSURE_TEMPLATES.callback;
    }

    if (ctx.callPurpose === 'telemarketing') {
      return DISCLOSURE_TEMPLATES.outbound_sales;
    }

    return DISCLOSURE_TEMPLATES.outbound_transactional;
  }

  /** Gate 5 addenda: Check if state requires extra disclosure */
  getStateDisclosureAddendum(state: string): string | null {
    const addenda: Record<string, string> = {
      UT: 'As required by Utah law, I\'m disclosing that I use generative AI technology.',
      CO: 'You have the right to opt out of AI-assisted interactions.',
    };
    return addenda[state] ?? null;
  }

  /** Gate 6: Does this call require recording consent? */
  requiresRecordingConsent(ctx: CallContext): boolean {
    return this.config.twoPartyConsentStates.includes(ctx.recipientState);
  }

  // ==========================================================================
  // REAL-TIME GATES (continuous during call)
  // ==========================================================================

  /** Gate 7: Check transcript chunk for opt-out or handoff keywords */
  checkTranscriptForTriggers(text: string): TranscriptTrigger | null {
    const lower = text.toLowerCase();

    // Check hard opt-out keywords
    for (const keyword of this.config.optOutKeywords) {
      if (lower.includes(keyword)) {
        return { type: 'opt_out', keyword, confidence: 1.0 };
      }
    }

    // Check human handoff keywords
    for (const keyword of this.config.humanHandoffKeywords) {
      if (lower.includes(keyword)) {
        return { type: 'human_handoff', keyword, confidence: 1.0 };
      }
    }

    // Fuzzy matching for natural language opt-outs
    const fuzzyOptOutPatterns = [
      /don'?t\s+(call|contact|phone)\s+me/i,
      /stop\s+(calling|contacting)/i,
      /i\s+want\s+(to\s+)?(stop|opt\s*out|be\s+removed)/i,
      /take\s+me\s+off/i,
      /no\s+more\s+(calls|messages)/i,
      /please\s+don'?t\s+call/i,
      /leave\s+me\s+alone/i,
    ];

    for (const pattern of fuzzyOptOutPatterns) {
      if (pattern.test(text)) {
        return { type: 'opt_out', keyword: text, confidence: 0.9 };
      }
    }

    // Fuzzy matching for human handoff
    const fuzzyHandoffPatterns = [
      /talk\s+to\s+(a|an|some)\s*(real|actual|live)?\s*(person|human|agent)/i,
      /speak\s+(with|to)\s+(a|someone|somebody)/i,
      /get\s+me\s+(a|an)\s*(real|actual|live)?\s*(person|human|agent)/i,
      /i\s+(need|want)\s+(a|to\s+talk\s+to\s+a)\s*(real|actual|live)?\s*(person|human)/i,
      /transfer\s+me/i,
      /connect\s+me/i,
    ];

    for (const pattern of fuzzyHandoffPatterns) {
      if (pattern.test(text)) {
        return { type: 'human_handoff', keyword: text, confidence: 0.9 };
      }
    }

    return null;
  }

  /** Gate 8: Check if text contains PII patterns that shouldn't be logged */
  detectPII(text: string): PIIDetection[] {
    const detections: PIIDetection[] = [];

    // SSN pattern
    if (/\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/.test(text)) {
      detections.push({ type: 'ssn', confidence: 0.95 });
    }

    // Credit card pattern (basic — Deepgram handles the real detection)
    if (/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/.test(text)) {
      detections.push({ type: 'credit_card', confidence: 0.90 });
    }

    // Routing number (9 digits)
    if (/\b\d{9}\b/.test(text) && text.toLowerCase().includes('routing')) {
      detections.push({ type: 'routing_number', confidence: 0.80 });
    }

    return detections;
  }

  /** Gate 9: Check if a pricing response is stale */
  isPricingStale(priceTimestamp: Date): boolean {
    const age = (Date.now() - priceTimestamp.getTime()) / 1000;
    return age > this.config.financial.priceStalenessThresholdSeconds;
  }

  /** Gate 9: Check if transaction requires human escalation */
  requiresHumanForAmount(amount: number): boolean {
    return amount >= this.config.financial.requireHumanForTransactionsAbove;
  }

  /** Gate 9: Check if response contains investment advice patterns */
  containsInvestmentAdvice(text: string): boolean {
    const advicePatterns = [
      /you\s+should\s+(buy|sell|invest|hold)/i,
      /i\s+(recommend|suggest|advise)\s+(buying|selling|investing)/i,
      /now\s+is\s+a\s+good\s+time\s+to/i,
      /gold\s+(is|will)\s+(going|go)\s+(up|down)/i,
      /this\s+is\s+a\s+(safe|good|smart)\s+investment/i,
      /you\s+(should|might\s+want\s+to)\s+diversify/i,
      /better\s+than\s+(stocks|bonds|the\s+market)/i,
      /guaranteed\s+(returns?|growth|income)/i,
    ];

    return advicePatterns.some(p => p.test(text));
  }

  // ==========================================================================
  // POST-CALL
  // ==========================================================================

  /** Gate 10: Generate compliance scorecard for the call */
  generateComplianceScorecard(session: {
    disclosureDelivered: boolean;
    disclosureTimingMs: number;
    recordingConsentObtained: boolean;
    optOutRequestsHonored: boolean;
    piiIncidents: number;
    piiRedactionApplied: boolean;
    pricingDisclaimersDelivered: number;
    humanHandoffs: number;
    callWithinPermittedHours: boolean;
    consentWasValidAtDial: boolean;
    dncWasClearAtDial: boolean;
    callerIdWasValid: boolean;
    financialGuardrailsTriggered: number;
    investmentAdviceBlocked: number;
  }): ComplianceScorecard {
    const allPassed =
      session.disclosureDelivered &&
      session.callWithinPermittedHours &&
      session.consentWasValidAtDial &&
      session.dncWasClearAtDial &&
      session.callerIdWasValid &&
      session.piiRedactionApplied &&
      session.optOutRequestsHonored &&
      session.investmentAdviceBlocked === 0;

    return {
      ...session,
      overallPass: allPassed,
      eligibleForTrainingData: allPassed && session.recordingConsentObtained,
      requiresComplianceReview: !allPassed || session.investmentAdviceBlocked > 0,
    };
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private getNextValidWindow(ctx: CallContext): Date {
    const next = new Date(ctx.currentTimeRecipientTZ);
    next.setHours(this.config.callHours.earliest, 0, 0, 0);
    if (next <= ctx.currentTimeRecipientTZ) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }
}

// ============================================================================
// Supporting Types
// ============================================================================

export interface TranscriptTrigger {
  type: 'opt_out' | 'human_handoff';
  keyword: string;
  confidence: number;
}

export interface PIIDetection {
  type: 'ssn' | 'credit_card' | 'routing_number' | 'account_number' | 'dob' | 'tax_id';
  confidence: number;
}

export interface ComplianceScorecard {
  disclosureDelivered: boolean;
  disclosureTimingMs: number;
  recordingConsentObtained: boolean;
  optOutRequestsHonored: boolean;
  piiIncidents: number;
  piiRedactionApplied: boolean;
  pricingDisclaimersDelivered: number;
  humanHandoffs: number;
  callWithinPermittedHours: boolean;
  consentWasValidAtDial: boolean;
  dncWasClearAtDial: boolean;
  callerIdWasValid: boolean;
  financialGuardrailsTriggered: number;
  investmentAdviceBlocked: number;
  overallPass: boolean;
  eligibleForTrainingData: boolean;
  requiresComplianceReview: boolean;
}

// ============================================================================
// Disclosure Templates
// ============================================================================

const DISCLOSURE_TEMPLATES = {
  inbound_default: `Hi, you've reached Constitutional Tender. I'm an AI assistant and I'm here to help. You can ask to speak with a person at any time. How can I help you today?`,

  outbound_transactional: `Hi, this is an AI assistant calling from Constitutional Tender regarding your account. You can ask for a human agent at any time. I have a quick update for you.`,

  outbound_sales: `Hi, this is an AI assistant calling on behalf of Constitutional Tender. This call may be recorded. You can ask to speak with a person or say 'stop' at any time. Is now a good time?`,

  callback: `Hi, this is Constitutional Tender returning your call. I'm an AI assistant — a human agent is also available if you prefer. How can I help?`,

  // Model-specific variants
  dmc_default: `Hi, you've reached DMC Banking. I'm an AI assistant ready to help with your account. A human agent is always available if you prefer. How can I help?`,

  tilt_broker: `Thanks for calling TILT Lending. I'm an AI assistant that can help capture your deal details and provide indicative terms. A human specialist is available if you prefer. Are you a broker or a borrower?`,

  eureka_default: `Hi, you've reached Eureka Settlement Services. I'm an AI assistant that can help with settlement coordination. A specialist is available if needed. How can I help?`,
} as const;

export { DISCLOSURE_TEMPLATES };
