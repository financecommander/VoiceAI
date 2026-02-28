/**
 * Mortgage Flow — Residential Mortgage Origination
 *
 * Pre-qualification → rate shop → application → disclosure → lock.
 * Heavy compliance: TRID, Reg B/ECOA, RESPA, fair lending.
 *
 * Phases: greeting → pre_qual → rate_shop → application → disclosure → rate_lock → close
 */

import type { ConversationPhase, PhaseTransition, FlowState, AgentModel } from './types.js';
import { BaseFlowController } from './base-flow.js';

const REQUIRED_FIELDS = [
  'borrowerName', 'propertyAddress', 'propertyType', 'occupancy',
  'purchasePrice', 'downPayment', 'loanAmount', 'annualIncome',
  'employmentStatus', 'creditScoreRange', 'contactPhone', 'contactEmail',
];

export class MortgageFlowController extends BaseFlowController {
  readonly model: AgentModel = 'MORTGAGE';
  readonly agentName = 'Calculus Mortgage Advisor';
  readonly voiceId = 'd1e2f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f6a';
  readonly crmTarget: 'ghl' = 'ghl';

  readonly phases: ConversationPhase[] = [
    {
      id: 'greeting', label: 'Greeting', minAuthTier: 0, tools: [],
      preferredProvider: 'grok-voice', maxTurns: 3, timeoutPhase: 'pre_qual',
      systemPromptSegment: `Greet the caller for Calculus Mortgage. Ask if they're looking to purchase a home, refinance, or have questions about their existing mortgage application.`,
    },
    {
      id: 'pre_qual', label: 'Pre-Qualification', minAuthTier: 0,
      tools: ['mortgage_getRates', 'mortgage_getPrograms'],
      preferredProvider: 'claude',
      systemPromptSegment: `Run a pre-qualification. Collect: property type (SFR, condo, 2-4 unit, townhouse), occupancy (primary, second home, investment), purchase price or estimated value, desired loan amount, annual household income, employment type (W-2, self-employed, retired), and approximate credit score range. DO NOT ask for exact credit score or SSN. Be conversational.

COMPLIANCE: Under ECOA/Reg B, do NOT ask about marital status, race, national origin, religion, or sex. Do not make assumptions about ability to qualify based on any protected characteristic.`,
    },
    {
      id: 'rate_shop', label: 'Rate Shopping', minAuthTier: 0,
      tools: ['mortgage_getRates', 'mortgage_getPrograms', 'mortgage_calculatePayment'],
      preferredProvider: 'claude',
      systemPromptSegment: `Present available programs and rates. Show: conventional, FHA, VA (if eligible), USDA (if rural). For each: rate, APR, estimated monthly payment (PITI), and points. Explain the tradeoff between rate and points. This is an estimate only — final rate depends on full application and credit pull.

COMPLIANCE: You must state that rates shown are estimates and subject to change. Final terms require a full application and credit review.`,
    },
    {
      id: 'authenticate', label: 'Identity Verification', minAuthTier: 0,
      tools: ['auth_verifyPhone', 'auth_requestOTP', 'auth_verifyOTP'],
      preferredProvider: 'gpt-4o', maxTurns: 8, timeoutPhase: 'escalate',
      systemPromptSegment: `Verify identity before taking a formal application. Collect name and verify phone via OTP.`,
    },
    {
      id: 'application', label: 'Loan Application (1003)', minAuthTier: 1,
      tools: ['mortgage_startApplication', 'mortgage_saveProgress'],
      preferredProvider: 'claude',
      systemPromptSegment: `Begin the Uniform Residential Loan Application (1003). Collect section by section conversationally: borrower info, employment history (2 years), income, assets, liabilities, property details, declarations. Mark required disclosures as pending. Save progress after each section.

COMPLIANCE: Under TRID, within 3 business days of receiving a complete application (name, income, SSN, property, loan amount, estimated value), you must issue a Loan Estimate. Remind the borrower that a credit pull will be needed to proceed and requires their authorization.`,
    },
    {
      id: 'disclosure', label: 'Disclosure Delivery', minAuthTier: 1,
      tools: ['mortgage_sendDisclosures', 'mortgage_getDisclosureStatus'],
      preferredProvider: 'claude', requiresConfirmation: true,
      systemPromptSegment: `Inform the borrower that required disclosures will be sent: Loan Estimate (within 3 business days), privacy notice, and state-specific disclosures. Confirm their email for electronic delivery. Explain the 3-day review period for the Loan Estimate.`,
    },
    {
      id: 'rate_lock', label: 'Rate Lock', minAuthTier: 2,
      tools: ['mortgage_lockRate', 'mortgage_getRates'],
      preferredProvider: 'claude', requiresConfirmation: true,
      systemPromptSegment: `Lock the rate. Confirm: loan program, rate, points, lock duration (typically 30, 45, or 60 days), and estimated closing date. Explain that a locked rate is guaranteed for the lock period. Get verbal confirmation before locking.`,
    },
    {
      id: 'close', label: 'Closing', minAuthTier: 0, tools: ['crm_logInteraction'],
      preferredProvider: 'grok-voice', maxTurns: 3,
      systemPromptSegment: `Summarize: where the application stands, next steps (documents needed, appraisal, underwriting timeline). Provide the loan officer's contact info for follow-up.`,
    },
    {
      id: 'escalate', label: 'Transfer to Loan Officer', minAuthTier: 0,
      tools: ['transfer_toAgent'],
      preferredProvider: 'gpt-4o', maxTurns: 2,
      systemPromptSegment: `Transfer to a mortgage loan officer. Summarize: purchase/refi, property type, loan amount, pre-qual status, and any rates discussed.`,
    },
  ];

  readonly transitions: PhaseTransition[] = [
    { from: 'greeting', to: 'pre_qual', condition: { type: 'intent_any', intents: ['purchase', 'pre_qualify', 'refinance', 'mortgage_inquiry'] }, priority: 20 },
    { from: 'greeting', to: 'authenticate', condition: { type: 'intent', intent: 'check_application' }, priority: 15 },
    { from: 'greeting', to: 'escalate', condition: { type: 'intent', intent: 'human_handoff' }, priority: 30 },
    { from: 'pre_qual', to: 'rate_shop', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'rate_shop', to: 'authenticate', condition: { type: 'intent_any', intents: ['apply', 'start_application', 'lock_rate'] }, priority: 20 },
    { from: 'rate_shop', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'authenticate', to: 'application', condition: { type: 'auth_upgrade', tier: 1 }, priority: 10 },
    { from: 'authenticate', to: 'escalate', condition: { type: 'escalation', reason: 'auth_failed' }, priority: 20 },
    { from: 'application', to: 'disclosure', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'disclosure', to: 'rate_lock', condition: { type: 'user_confirms' }, priority: 15 },
    { from: 'disclosure', to: 'close', condition: { type: 'user_declines' }, priority: 10 },
    { from: 'rate_lock', to: 'close', condition: { type: 'phase_complete' }, priority: 10 },
  ];

  protected getModelPromptHeader(): string {
    return `AGENT: ${this.agentName}\nMODEL: Residential Mortgage Origination\nCOMPLIANCE: TRID, ECOA/Reg B, RESPA, Fair Lending\nPROGRAMS: Conventional, FHA, VA, USDA, Jumbo, Non-QM`;
  }

  getInitialPhase(): string { return 'greeting'; }

  getRequiredFields(state: FlowState): string[] {
    return REQUIRED_FIELDS.filter(f => !(f in state.collectedData));
  }

  getCompletionPercentage(state: FlowState): number {
    const collected = REQUIRED_FIELDS.filter(f => f in state.collectedData).length;
    return Math.round((collected / REQUIRED_FIELDS.length) * 100);
  }

  getGreeting(_dir: 'inbound' | 'outbound', name?: string): string {
    return name
      ? `Thank you for calling Calculus Mortgage. I'm your AI mortgage advisor. Hi ${name} — are you looking to purchase, refinance, or checking on an application?`
      : `Thank you for calling Calculus Mortgage. I'm your AI mortgage advisor. Are you looking to buy a home, refinance, or do you have questions about a current application?`;
  }

  getClosing(state: FlowState): string {
    if (state.collectedData.applicationStarted) {
      return `Your application is in progress. You'll receive the Loan Estimate via email within 3 business days. A loan officer will be in touch to discuss next steps. Thank you!`;
    }
    return `Thank you for calling Calculus Mortgage. We'd love to help when you're ready — call back anytime. Have a great day!`;
  }

  getEscalationMessage(): string {
    return `Let me connect you with a licensed mortgage loan officer. One moment please.`;
  }
}
