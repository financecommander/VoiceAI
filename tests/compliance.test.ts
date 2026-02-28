/**
 * ComplianceEnforcer Gate Tests
 *
 * Verifies all 10 gates function correctly:
 * Pre-dial: consent, DNC, time, caller ID
 * Call-start: disclosure, recording consent
 * Real-time: opt-out, PII, financial accuracy
 * Post-call: scorecard generation
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ComplianceEnforcer,
  DEFAULT_COMPLIANCE_CONFIG,
} from '../src/compliance/enforcer.js';
import type { CallContext } from '../src/compliance/enforcer.js';
import type { ConsentRecord, DNCResult, IConsentService, IAuditService } from '../src/services/contracts.js';
import pino from 'pino';

// Mock services
const mockConsentService: IConsentService = {
  getConsent: vi.fn(),
  captureConsent: vi.fn(),
  revokeConsent: vi.fn(),
  checkDNC: vi.fn().mockResolvedValue({
    onNationalDNC: false,
    onStateDNC: false,
    onInternalSuppression: false,
    numberReassigned: false,
  } satisfies DNCResult),
  addToSuppression: vi.fn(),
};

const mockAuditService: IAuditService = {
  logEvent: vi.fn().mockResolvedValue('event-id'),
  getConversationAudit: vi.fn(),
};

const logger = pino({ level: 'silent' });

function createEnforcer() {
  return new ComplianceEnforcer(
    DEFAULT_COMPLIANCE_CONFIG,
    mockConsentService,
    mockAuditService,
    logger,
  );
}

function createCallContext(overrides: Partial<CallContext> = {}): CallContext {
  return {
    conversationId: 'test-conv-id',
    callDirection: 'outbound',
    callType: 'callback',
    callPurpose: 'informational',
    recipientPhone: '+15551234567',
    recipientState: 'CT',
    recipientPhoneType: 'mobile',
    callerIdNumber: '+18001234567',
    callerIdName: 'Constitutional Tender',
    currentAuthTier: 1,
    customerId: 'cust-123',
    currentTimeRecipientTZ: new Date('2026-02-16T14:00:00'),
    consentRecord: {
      phone: '+15551234567',
      customerId: 'cust-123',
      aiWrittenConsent: true,
      aiConsentTimestamp: new Date('2026-01-15'),
      aiConsentSeller: 'Constitutional Tender',
      automatedConsent: true,
      automatedConsentTimestamp: new Date('2026-01-15'),
      recordingConsent: true,
      callbackRequested: true,
      callbackRequestedAt: new Date(Date.now() - 3600000), // 1 hour ago
      ebrStatus: true,
      ebrLastTransaction: new Date('2026-02-01'),
      revocationHistory: [],
      reOptedInAfterLastRevocation: false,
    },
    dncResult: {
      onNationalDNC: false,
      onStateDNC: false,
      onInternalSuppression: false,
      numberReassigned: false,
    },
    ...overrides,
  };
}

describe('ComplianceEnforcer', () => {
  // ==========================================================================
  // Gate 1: Consent Verification
  // ==========================================================================

  describe('Gate 1: Consent', () => {
    it('passes with valid consent', async () => {
      const enforcer = createEnforcer();
      const ctx = createCallContext();
      const results = await enforcer.runPreDialGates(ctx);
      const consentGate = results.find(r => r.gateId === 'consent_gate');
      expect(consentGate?.passed).toBe(true);
    });

    it('blocks when no consent record', async () => {
      const enforcer = createEnforcer();
      const ctx = createCallContext({ consentRecord: null });
      const results = await enforcer.runPreDialGates(ctx);
      const consentGate = results.find(r => r.gateId === 'consent_gate');
      expect(consentGate?.passed).toBe(false);
      expect(consentGate?.reason).toContain('No consent record');
    });

    it('blocks when consent revoked', async () => {
      const enforcer = createEnforcer();
      const ctx = createCallContext({
        consentRecord: {
          ...createCallContext().consentRecord!,
          revocationHistory: [{
            revokedAt: new Date(),
            method: 'verbal',
            scope: 'all_automated',
            conversationId: 'prev-conv',
          }],
          reOptedInAfterLastRevocation: false,
        },
      });
      const results = await enforcer.runPreDialGates(ctx);
      const consentGate = results.find(r => r.gateId === 'consent_gate');
      expect(consentGate?.passed).toBe(false);
      expect(consentGate?.reason).toContain('revoked');
    });

    it('blocks telemarketing without written AI consent', async () => {
      const enforcer = createEnforcer();
      const ctx = createCallContext({
        callPurpose: 'telemarketing',
        consentRecord: {
          ...createCallContext().consentRecord!,
          aiWrittenConsent: false,
          aiConsentTimestamp: null,
        },
      });
      const results = await enforcer.runPreDialGates(ctx);
      const consentGate = results.find(r => r.gateId === 'consent_gate');
      expect(consentGate?.passed).toBe(false);
    });

    it('blocks expired callback request (>72 hours)', async () => {
      const enforcer = createEnforcer();
      const ctx = createCallContext({
        consentRecord: {
          ...createCallContext().consentRecord!,
          callbackRequestedAt: new Date(Date.now() - 80 * 3600000), // 80 hours ago
        },
      });
      const results = await enforcer.runPreDialGates(ctx);
      const consentGate = results.find(r => r.gateId === 'consent_gate');
      expect(consentGate?.passed).toBe(false);
      expect(consentGate?.reason).toContain('expired');
    });
  });

  // ==========================================================================
  // Gate 2: DNC
  // ==========================================================================

  describe('Gate 2: DNC', () => {
    it('blocks National DNC', async () => {
      const enforcer = createEnforcer();
      const ctx = createCallContext({
        dncResult: {
          onNationalDNC: true,
          onStateDNC: false,
          onInternalSuppression: false,
          numberReassigned: false,
        },
      });
      const results = await enforcer.runPreDialGates(ctx);
      const dncGate = results.find(r => r.gateId === 'dnc_gate');
      expect(dncGate?.passed).toBe(false);
    });

    it('blocks internal suppression', async () => {
      const enforcer = createEnforcer();
      const ctx = createCallContext({
        dncResult: {
          onNationalDNC: false,
          onStateDNC: false,
          onInternalSuppression: true,
          numberReassigned: false,
        },
      });
      const results = await enforcer.runPreDialGates(ctx);
      const dncGate = results.find(r => r.gateId === 'dnc_gate');
      expect(dncGate?.passed).toBe(false);
    });
  });

  // ==========================================================================
  // Gate 3: Time-of-Day
  // ==========================================================================

  describe('Gate 3: Time', () => {
    it('blocks calls before 8 AM', () => {
      const enforcer = createEnforcer();
      const ctx = createCallContext({
        currentTimeRecipientTZ: new Date('2026-02-16T07:30:00'),
      });
      const result = enforcer.checkTimeOfDay(ctx);
      expect(result.passed).toBe(false);
    });

    it('blocks calls after 9 PM', () => {
      const enforcer = createEnforcer();
      const ctx = createCallContext({
        currentTimeRecipientTZ: new Date('2026-02-16T21:30:00'),
      });
      const result = enforcer.checkTimeOfDay(ctx);
      expect(result.passed).toBe(false);
    });

    it('allows calls during business hours', () => {
      const enforcer = createEnforcer();
      const ctx = createCallContext({
        currentTimeRecipientTZ: new Date('2026-02-16T14:00:00'),
      });
      const result = enforcer.checkTimeOfDay(ctx);
      expect(result.passed).toBe(true);
    });
  });

  // ==========================================================================
  // Gate 5: Disclosure
  // ==========================================================================

  describe('Gate 5: Disclosure Templates', () => {
    it('returns inbound template for inbound calls', () => {
      const enforcer = createEnforcer();
      const ctx = createCallContext({ callDirection: 'inbound' });
      const template = enforcer.getDisclosureTemplate(ctx);
      expect(template).toContain('AI assistant');
      expect(template).toContain('speak with a person');
    });

    it('returns callback template for callbacks', () => {
      const enforcer = createEnforcer();
      const ctx = createCallContext({ callType: 'callback' });
      const template = enforcer.getDisclosureTemplate(ctx);
      expect(template).toContain('returning your call');
    });

    it('returns sales template for telemarketing', () => {
      const enforcer = createEnforcer();
      const ctx = createCallContext({ callPurpose: 'telemarketing', callType: 'sales' });
      const template = enforcer.getDisclosureTemplate(ctx);
      expect(template).toContain('recorded');
      expect(template).toContain('stop');
    });
  });

  // ==========================================================================
  // Gate 6: Recording Consent
  // ==========================================================================

  describe('Gate 6: Recording Consent', () => {
    it('requires consent in two-party states (CT)', () => {
      const enforcer = createEnforcer();
      const ctx = createCallContext({ recipientState: 'CT' });
      expect(enforcer.requiresRecordingConsent(ctx)).toBe(true);
    });

    it('does not require consent in one-party states (NY)', () => {
      const enforcer = createEnforcer();
      const ctx = createCallContext({ recipientState: 'NY' });
      expect(enforcer.requiresRecordingConsent(ctx)).toBe(false);
    });
  });

  // ==========================================================================
  // Gate 7: Opt-Out & Handoff Detection
  // ==========================================================================

  describe('Gate 7: Opt-Out Detection', () => {
    it('detects "stop"', () => {
      const enforcer = createEnforcer();
      const result = enforcer.checkTranscriptForTriggers('Please stop calling me');
      expect(result?.type).toBe('opt_out');
    });

    it('detects "do not call"', () => {
      const enforcer = createEnforcer();
      const result = enforcer.checkTranscriptForTriggers('Do not call me again');
      expect(result?.type).toBe('opt_out');
    });

    it('detects fuzzy opt-out: "don\'t call me anymore"', () => {
      const enforcer = createEnforcer();
      const result = enforcer.checkTranscriptForTriggers("I don't want you to call me anymore");
      expect(result?.type).toBe('opt_out');
    });

    it('detects "talk to a real person"', () => {
      const enforcer = createEnforcer();
      const result = enforcer.checkTranscriptForTriggers('I want to talk to a real person');
      expect(result?.type).toBe('human_handoff');
    });

    it('detects "transfer me"', () => {
      const enforcer = createEnforcer();
      const result = enforcer.checkTranscriptForTriggers('Can you transfer me to someone?');
      expect(result?.type).toBe('human_handoff');
    });

    it('returns null for normal conversation', () => {
      const enforcer = createEnforcer();
      const result = enforcer.checkTranscriptForTriggers("What's the current price of gold?");
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // Gate 8: PII Detection
  // ==========================================================================

  describe('Gate 8: PII Detection', () => {
    it('detects SSN pattern', () => {
      const enforcer = createEnforcer();
      const detections = enforcer.detectPII('My social is 123-45-6789');
      expect(detections.length).toBeGreaterThan(0);
      expect(detections[0].type).toBe('ssn');
    });

    it('detects credit card pattern', () => {
      const enforcer = createEnforcer();
      const detections = enforcer.detectPII('My card number is 4111 1111 1111 1111');
      expect(detections.length).toBeGreaterThan(0);
      expect(detections[0].type).toBe('credit_card');
    });

    it('returns empty for clean text', () => {
      const enforcer = createEnforcer();
      const detections = enforcer.detectPII('I want to buy 10 ounces of gold');
      expect(detections).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Gate 9: Financial Accuracy
  // ==========================================================================

  describe('Gate 9: Financial Accuracy', () => {
    it('flags stale prices (>5 min)', () => {
      const enforcer = createEnforcer();
      const sixMinAgo = new Date(Date.now() - 360000);
      expect(enforcer.isPricingStale(sixMinAgo)).toBe(true);
    });

    it('allows fresh prices (<5 min)', () => {
      const enforcer = createEnforcer();
      const oneMinAgo = new Date(Date.now() - 60000);
      expect(enforcer.isPricingStale(oneMinAgo)).toBe(false);
    });

    it('requires human for transactions above threshold', () => {
      const enforcer = createEnforcer();
      expect(enforcer.requiresHumanForAmount(15000)).toBe(true);
      expect(enforcer.requiresHumanForAmount(5000)).toBe(false);
    });

    it('detects investment advice patterns', () => {
      const enforcer = createEnforcer();
      expect(enforcer.containsInvestmentAdvice('You should buy gold right now')).toBe(true);
      expect(enforcer.containsInvestmentAdvice('Now is a good time to invest')).toBe(true);
      expect(enforcer.containsInvestmentAdvice('Gold is at $2400 per ounce')).toBe(false);
    });
  });

  // ==========================================================================
  // Gate 10: Scorecard
  // ==========================================================================

  describe('Gate 10: Post-Call Scorecard', () => {
    it('generates passing scorecard for compliant call', () => {
      const enforcer = createEnforcer();
      const scorecard = enforcer.generateComplianceScorecard({
        disclosureDelivered: true,
        disclosureTimingMs: 1200,
        recordingConsentObtained: true,
        optOutRequestsHonored: true,
        piiIncidents: 0,
        piiRedactionApplied: true,
        pricingDisclaimersDelivered: 2,
        humanHandoffs: 0,
        callWithinPermittedHours: true,
        consentWasValidAtDial: true,
        dncWasClearAtDial: true,
        callerIdWasValid: true,
        financialGuardrailsTriggered: 0,
        investmentAdviceBlocked: 0,
      });

      expect(scorecard.overallPass).toBe(true);
      expect(scorecard.eligibleForTrainingData).toBe(true);
      expect(scorecard.requiresComplianceReview).toBe(false);
    });

    it('flags non-compliant call for review', () => {
      const enforcer = createEnforcer();
      const scorecard = enforcer.generateComplianceScorecard({
        disclosureDelivered: false,
        disclosureTimingMs: 0,
        recordingConsentObtained: false,
        optOutRequestsHonored: true,
        piiIncidents: 1,
        piiRedactionApplied: true,
        pricingDisclaimersDelivered: 0,
        humanHandoffs: 0,
        callWithinPermittedHours: true,
        consentWasValidAtDial: true,
        dncWasClearAtDial: true,
        callerIdWasValid: true,
        financialGuardrailsTriggered: 0,
        investmentAdviceBlocked: 0,
      });

      expect(scorecard.overallPass).toBe(false);
      expect(scorecard.eligibleForTrainingData).toBe(false);
      expect(scorecard.requiresComplianceReview).toBe(true);
    });

    it('blocks training data when recording consent denied', () => {
      const enforcer = createEnforcer();
      const scorecard = enforcer.generateComplianceScorecard({
        disclosureDelivered: true,
        disclosureTimingMs: 1000,
        recordingConsentObtained: false,
        optOutRequestsHonored: true,
        piiIncidents: 0,
        piiRedactionApplied: true,
        pricingDisclaimersDelivered: 1,
        humanHandoffs: 0,
        callWithinPermittedHours: true,
        consentWasValidAtDial: true,
        dncWasClearAtDial: true,
        callerIdWasValid: true,
        financialGuardrailsTriggered: 0,
        investmentAdviceBlocked: 0,
      });

      expect(scorecard.eligibleForTrainingData).toBe(false);
    });
  });

  // ==========================================================================
  // Inbound calls skip pre-dial gates
  // ==========================================================================

  describe('Inbound calls', () => {
    it('skip all pre-dial gates', async () => {
      const enforcer = createEnforcer();
      const ctx = createCallContext({ callDirection: 'inbound' });
      const results = await enforcer.runPreDialGates(ctx);
      expect(results).toHaveLength(0);
    });
  });
});
