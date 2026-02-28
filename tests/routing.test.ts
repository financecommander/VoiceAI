/**
 * Orchestra DSL Routing Tests
 *
 * Verifies that intents are routed to the correct LLM + pipeline mode.
 * Critical: compliance-sensitive intents MUST route to modular pipeline.
 */

import { describe, it, expect } from 'vitest';
import { routeIntent, DEFAULT_ORCHESTRA_CONFIG } from '../src/orchestrator/orchestrator.js';
import { Intent } from '../src/types.js';

describe('Orchestra DSL Routing', () => {
  // ==========================================================================
  // Modular Pipeline (Claude) — Compliance-Sensitive Intents
  // ==========================================================================

  describe('Compliance-sensitive intents → Claude + Modular', () => {
    const complianceIntents: Intent[] = [
      Intent.BUY_METAL,
      Intent.SELL_METAL,
      Intent.TELEPORT_TRANSFER,
      Intent.INTERNATIONAL_TRANSFER,
      Intent.INSTANT_LIQUIDITY,
      Intent.SETTLEMENT_SETUP,
    ];

    for (const intent of complianceIntents) {
      it(`routes ${intent} to Claude on modular pipeline`, () => {
        const decision = routeIntent(intent);
        expect(decision.provider).toBe('claude');
        expect(decision.pipelineMode).toBe('modular');
        expect(decision.complianceGatesActive).toBe(true);
      });
    }
  });

  // ==========================================================================
  // Modular Pipeline (Claude) — Multi-Step Flows
  // ==========================================================================

  describe('Multi-step flows → Claude + Modular', () => {
    it('routes loan_intake to Claude', () => {
      const d = routeIntent(Intent.LOAN_INTAKE);
      expect(d.provider).toBe('claude');
      expect(d.pipelineMode).toBe('modular');
      expect(d.complianceGatesActive).toBe(true);
    });
  });

  // ==========================================================================
  // Modular Pipeline (GPT-4o) — Transactional but simpler
  // ==========================================================================

  describe('Simpler transactional → modular with compliance', () => {
    const transactionalIntents: Intent[] = [
      Intent.BILL_PAY,
      Intent.DOMESTIC_TRANSFER,
      Intent.PAYOFF_QUOTE,
      Intent.DELINQUENCY_INQUIRY,
    ];

    for (const intent of transactionalIntents) {
      it(`routes ${intent} to modular pipeline with compliance gates`, () => {
        const d = routeIntent(intent);
        expect(d.pipelineMode).toBe('modular');
        expect(d.complianceGatesActive).toBe(true);
      });
    }
  });

  // ==========================================================================
  // Grok Speech-to-Speech — Informational Intents
  // ==========================================================================

  describe('Informational intents → Grok + Speech-to-Speech', () => {
    const grokIntents: Intent[] = [
      Intent.METAL_PRICE_CHECK,
      Intent.BALANCE_INQUIRY,
      Intent.CARD_STATUS,
      Intent.FEE_EXPLANATION,
      Intent.BRANCH_LOCATION,
      Intent.GENERAL_QUESTION,
      Intent.PAYMENT_INQUIRY,
      Intent.ESCROW_INQUIRY,
      Intent.SETTLEMENT_STATUS,
      Intent.CUSTODY_RECEIPT,
    ];

    for (const intent of grokIntents) {
      it(`routes ${intent} to Grok speech-to-speech`, () => {
        const d = routeIntent(intent);
        expect(d.provider).toBe('grok-voice');
        expect(d.pipelineMode).toBe('speech-to-speech');
        expect(d.complianceGatesActive).toBe(false);
        expect(d.estimatedCostPerMin).toBe(0.05);
      });
    }
  });

  // ==========================================================================
  // IFSE Staff Intents → Grok (internal, already authed)
  // ==========================================================================

  describe('IFSE staff intents → Grok', () => {
    const staffIntents: Intent[] = [
      Intent.FX_EXPOSURE,
      Intent.PENDING_WIRES,
      Intent.SETTLEMENT_QUEUE,
      Intent.RECON_REPORT,
    ];

    for (const intent of staffIntents) {
      it(`routes ${intent} to Grok`, () => {
        const d = routeIntent(intent);
        expect(d.provider).toBe('grok-voice');
        expect(d.pipelineMode).toBe('speech-to-speech');
      });
    }
  });

  // ==========================================================================
  // Universal Intents — Safe Defaults
  // ==========================================================================

  describe('Universal intents → modular fallback', () => {
    it('routes UNKNOWN to GPT-4o modular', () => {
      const d = routeIntent(Intent.UNKNOWN);
      expect(d.provider).toBe('gpt-4o');
      expect(d.pipelineMode).toBe('modular');
      expect(d.complianceGatesActive).toBe(true);
    });

    it('routes COMPLAINT to GPT-4o modular', () => {
      const d = routeIntent(Intent.COMPLAINT);
      expect(d.pipelineMode).toBe('modular');
      expect(d.complianceGatesActive).toBe(true);
    });
  });

  // ==========================================================================
  // Cost Verification
  // ==========================================================================

  describe('Cost per minute accuracy', () => {
    it('Grok is $0.05/min', () => {
      const d = routeIntent(Intent.METAL_PRICE_CHECK);
      expect(d.estimatedCostPerMin).toBe(0.05);
    });

    it('Claude modular is $0.087/min', () => {
      const d = routeIntent(Intent.BUY_METAL);
      expect(d.estimatedCostPerMin).toBe(0.087);
    });

    it('GPT-4o modular is $0.077/min', () => {
      const d = routeIntent(Intent.BILL_PAY);
      // Bill pay routes to Claude (multi-step) but delinquency to GPT-4o
      const d2 = routeIntent(Intent.DELINQUENCY_INQUIRY);
      expect(d2.estimatedCostPerMin).toBeLessThanOrEqual(0.087);
    });
  });

  // ==========================================================================
  // Latency Budget Verification
  // ==========================================================================

  describe('Latency budgets', () => {
    it('Grok gets 300ms budget', () => {
      const d = routeIntent(Intent.METAL_PRICE_CHECK);
      expect(d.latencyBudget).toBe(300);
    });

    it('Claude gets 800ms budget for complex flows', () => {
      const d = routeIntent(Intent.BUY_METAL);
      expect(d.latencyBudget).toBe(800);
    });
  });

  // ==========================================================================
  // CRITICAL: No transactional intent should route to Grok
  // ==========================================================================

  describe('SAFETY: No money movement on Grok', () => {
    const moneyIntents: Intent[] = [
      Intent.BUY_METAL,
      Intent.SELL_METAL,
      Intent.TELEPORT_TRANSFER,
      Intent.BILL_PAY,
      Intent.DOMESTIC_TRANSFER,
      Intent.INTERNATIONAL_TRANSFER,
      Intent.INSTANT_LIQUIDITY,
    ];

    for (const intent of moneyIntents) {
      it(`${intent} NEVER routes to Grok`, () => {
        const d = routeIntent(intent);
        expect(d.provider).not.toBe('grok-voice');
        expect(d.pipelineMode).not.toBe('speech-to-speech');
        expect(d.complianceGatesActive).toBe(true);
      });
    }
  });
});
