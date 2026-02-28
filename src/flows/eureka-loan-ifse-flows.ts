/**
 * Eureka Flow — Non-Custodial Settlement Coordination
 *
 * File status, doc tracking, multi-party coordination, wire instructions.
 * Read-heavy, status-oriented, multi-party context.
 *
 * Phases: greeting → authenticate → file_status|wire_instructions|doc_tracking → close
 */

import type { ConversationPhase, PhaseTransition, FlowState, AgentModel } from './types.js';
import { BaseFlowController } from './base-flow.js';

export class EurekaFlowController extends BaseFlowController {
  readonly model: AgentModel = 'EUREKA';
  readonly agentName = 'Eureka Settlement Coordinator';
  readonly voiceId = 'f3a4b5c6-d7e8-9f0a-1b2c-3d4e5f6a7b8c';
  readonly crmTarget: 'ghl' = 'ghl';

  readonly phases: ConversationPhase[] = [
    {
      id: 'greeting', label: 'Greeting', minAuthTier: 0, tools: [],
      preferredProvider: 'grok-voice', maxTurns: 3, timeoutPhase: 'authenticate',
      systemPromptSegment: `Greet the caller for Eureka Settlement Services. We coordinate real estate closings. Ask for their file number or name to look up their settlement.`,
    },
    {
      id: 'authenticate', label: 'File Verification', minAuthTier: 0,
      tools: ['auth_verifyPhone', 'auth_requestOTP', 'auth_verifyOTP'],
      preferredProvider: 'gpt-4o', maxTurns: 6, timeoutPhase: 'escalate',
      systemPromptSegment: `Verify the caller's identity and locate their settlement file. Match by file number, property address, or party name + phone.`,
    },
    {
      id: 'file_status', label: 'File Status', minAuthTier: 1,
      tools: ['eureka_getFileStatus', 'eureka_getTimeline', 'eureka_getParties', 'eureka_getConditions'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Provide settlement file status: current stage (title search, document prep, scheduling, closing, post-close), pending conditions, key dates, and party status. Be specific about what's needed and from whom.`,
    },
    {
      id: 'wire_instructions', label: 'Wire Instructions', minAuthTier: 2,
      tools: ['eureka_getWireInstructions', 'eureka_verifyWireReceipt'],
      preferredProvider: 'claude', requiresConfirmation: true,
      systemPromptSegment: `Provide wire instructions for closing funds. SECURITY: Read wire details slowly and clearly. Remind the caller to verify wire instructions via a separate channel (not email) to prevent wire fraud. Confirm the amount and recipient. Never provide wire details via email in this call.`,
    },
    {
      id: 'doc_tracking', label: 'Document Tracking', minAuthTier: 1,
      tools: ['eureka_getDocumentStatus', 'eureka_requestDocument', 'eureka_getChecklist'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Track settlement documents. Show what's received, pending, and overdue. Explain each document's purpose and who needs to provide it. Offer to send reminders to outstanding parties.`,
    },
    {
      id: 'scheduling', label: 'Closing Scheduling', minAuthTier: 1,
      tools: ['eureka_getAvailability', 'eureka_scheduleClosing', 'eureka_getClosingDetails'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Schedule or confirm closing details: date, time, location (office, remote/RON, mobile notary), and attendees. Confirm all parties can attend.`,
    },
    {
      id: 'close', label: 'Closing', minAuthTier: 0, tools: ['crm_logInteraction'],
      preferredProvider: 'grok-voice', maxTurns: 3,
      systemPromptSegment: `Summarize file status and any actions taken. Confirm next steps and key dates.`,
    },
    {
      id: 'escalate', label: 'Transfer to Closer', minAuthTier: 0,
      tools: ['transfer_toAgent'],
      preferredProvider: 'gpt-4o', maxTurns: 2,
      systemPromptSegment: `Transfer to a settlement officer. Summarize: file number, property, and what the caller needs.`,
    },
  ];

  readonly transitions: PhaseTransition[] = [
    { from: 'greeting', to: 'authenticate', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'greeting', to: 'escalate', condition: { type: 'intent', intent: 'human_handoff' }, priority: 30 },
    { from: 'authenticate', to: 'file_status', condition: { type: 'auth_upgrade', tier: 1 }, priority: 10 },
    { from: 'authenticate', to: 'escalate', condition: { type: 'escalation', reason: 'auth_failed' }, priority: 20 },
    { from: 'file_status', to: 'wire_instructions', condition: { type: 'intent', intent: 'wire_info' }, priority: 15 },
    { from: 'file_status', to: 'doc_tracking', condition: { type: 'intent', intent: 'documents' }, priority: 15 },
    { from: 'file_status', to: 'scheduling', condition: { type: 'intent', intent: 'schedule_closing' }, priority: 15 },
    { from: 'file_status', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'wire_instructions', to: 'close', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'doc_tracking', to: 'close', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'scheduling', to: 'close', condition: { type: 'phase_complete' }, priority: 10 },
  ];

  protected getModelPromptHeader(): string {
    return `AGENT: ${this.agentName}\nMODEL: Eureka Settlement Services — Non-Custodial Closing Coordination\nSECURITY: Wire fraud prevention is critical. Always verify wire instructions verbally.`;
  }

  getInitialPhase(): string { return 'greeting'; }

  getGreeting(_dir: 'inbound' | 'outbound', name?: string): string {
    return name
      ? `Thank you for calling Eureka Settlement Services. I'm your AI coordinator. Hi ${name} — do you have a file number handy?`
      : `Thank you for calling Eureka Settlement Services. I'm your AI coordinator. Do you have your file number, or can I look you up by property address?`;
  }

  getClosing(): string {
    return `Is there anything else about your settlement? Thank you for choosing Eureka. Have a great day!`;
  }

  getEscalationMessage(): string {
    return `Let me connect you with your settlement officer. One moment please.`;
  }
}

// ============================================================================
// Loan Servicing Flow — Post-close loan management (LoanPro)
// ============================================================================

/**
 * Loan Servicing Flow — Post-Close Loan Management via LoanPro
 *
 * Payment status, payoff quotes, escrow analysis, modification requests, forbearance.
 * Regulated servicing: RESPA, TILA, CFPB guidelines.
 *
 * Phases: greeting → authenticate → account_overview|payment|payoff|escrow|modification → close
 */

export class LoanServicingFlowController extends BaseFlowController {
  readonly model: AgentModel = 'LOAN_SERVICING';
  readonly agentName = 'Calculus Loan Services';
  readonly voiceId = 'a4b5c6d7-e8f9-0a1b-2c3d-4e5f6a7b8c9d';
  readonly crmTarget: 'hubspot' = 'hubspot';

  readonly phases: ConversationPhase[] = [
    {
      id: 'greeting', label: 'Greeting', minAuthTier: 0, tools: [],
      preferredProvider: 'grok-voice', maxTurns: 3, timeoutPhase: 'authenticate',
      systemPromptSegment: `Greet the caller for Calculus Loan Services. We manage existing loans. Ask for their loan number or the property address.`,
    },
    {
      id: 'authenticate', label: 'Borrower Verification', minAuthTier: 0,
      tools: ['auth_verifyPhone', 'auth_requestOTP', 'auth_verifyOTP'],
      preferredProvider: 'gpt-4o', maxTurns: 8, timeoutPhase: 'escalate',
      systemPromptSegment: `Verify borrower identity. Match by loan number + last 4 SSN, or property address + name + phone. Sensitive operations (payoff, modification) require OTP.`,
    },
    {
      id: 'account_overview', label: 'Account Overview', minAuthTier: 1,
      tools: ['loanpro_getLoanDetails', 'loanpro_getPaymentHistory', 'loanpro_getNextPayment'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Present the loan overview: current balance, interest rate, payment amount, next due date, escrow balance, and payment history. Flag if the account is past due or in special servicing.`,
    },
    {
      id: 'payment', label: 'Payment Processing', minAuthTier: 2,
      tools: ['loanpro_makePayment', 'loanpro_setupAutoPay', 'loanpro_getPaymentMethods'],
      preferredProvider: 'claude', requiresConfirmation: true,
      systemPromptSegment: `Process a loan payment. Confirm: amount (regular, extra principal, or custom), payment method (ACH, debit card), and effective date. For auto-pay setup: confirm day of month and account. Always confirm before processing.`,
    },
    {
      id: 'payoff', label: 'Payoff Quote', minAuthTier: 2,
      tools: ['loanpro_getPayoffQuote', 'loanpro_emailPayoffStatement'],
      preferredProvider: 'claude',
      systemPromptSegment: `Generate a payoff quote. Provide: payoff amount, good-through date, per-diem interest, wire instructions for payoff. Offer to email the official payoff statement. Payoff quotes are typically valid for 10-15 days.`,
    },
    {
      id: 'escrow', label: 'Escrow Analysis', minAuthTier: 1,
      tools: ['loanpro_getEscrowDetails', 'loanpro_getEscrowProjection'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Explain the escrow account: current balance, monthly escrow payment, what it covers (taxes, insurance, PMI/MIP), last disbursements, and projected adjustment. If there's a shortage or surplus, explain the options.`,
    },
    {
      id: 'modification', label: 'Loan Modification', minAuthTier: 2,
      tools: ['loanpro_startModification', 'loanpro_getModificationStatus', 'loanpro_getForbearanceOptions'],
      preferredProvider: 'claude',
      systemPromptSegment: `Handle modification or hardship requests. Collect: nature of hardship, current income, desired outcome. Explain available options: forbearance, rate modification, term extension, principal deferment. Note that all modifications are subject to approval and may affect credit reporting.

COMPLIANCE: Under CFPB servicing rules, you must acknowledge loss mitigation applications within 5 business days and provide reasonable time for the borrower to submit required documents.`,
    },
    {
      id: 'close', label: 'Closing', minAuthTier: 0, tools: ['crm_logInteraction'],
      preferredProvider: 'grok-voice', maxTurns: 3,
      systemPromptSegment: `Summarize actions taken and next steps. Confirm the borrower has what they need.`,
    },
    {
      id: 'escalate', label: 'Transfer to Servicer', minAuthTier: 0,
      tools: ['transfer_toAgent'],
      preferredProvider: 'gpt-4o', maxTurns: 2,
      systemPromptSegment: `Transfer to a loan servicing specialist. Summarize: loan number, borrower situation, and what they need.`,
    },
  ];

  readonly transitions: PhaseTransition[] = [
    { from: 'greeting', to: 'authenticate', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'greeting', to: 'escalate', condition: { type: 'intent', intent: 'human_handoff' }, priority: 30 },
    { from: 'authenticate', to: 'account_overview', condition: { type: 'auth_upgrade', tier: 1 }, priority: 10 },
    { from: 'authenticate', to: 'escalate', condition: { type: 'escalation', reason: 'auth_failed' }, priority: 20 },
    { from: 'account_overview', to: 'payment', condition: { type: 'intent_any', intents: ['make_payment', 'setup_autopay'] }, priority: 15 },
    { from: 'account_overview', to: 'payoff', condition: { type: 'intent', intent: 'payoff_quote' }, priority: 15 },
    { from: 'account_overview', to: 'escrow', condition: { type: 'intent', intent: 'escrow_inquiry' }, priority: 15 },
    { from: 'account_overview', to: 'modification', condition: { type: 'intent_any', intents: ['modification', 'hardship', 'forbearance'] }, priority: 15 },
    { from: 'account_overview', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'payment', to: 'close', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'payoff', to: 'close', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'escrow', to: 'close', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'modification', to: 'close', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'modification', to: 'escalate', condition: { type: 'escalation', reason: 'complex_modification' }, priority: 20 },
  ];

  protected getModelPromptHeader(): string {
    return `AGENT: ${this.agentName}\nMODEL: Loan Servicing via LoanPro\nCOMPLIANCE: RESPA, TILA, CFPB Servicing Rules, Fair Debt Collection Practices Act\nSERVICES: Payments, payoff quotes, escrow analysis, modifications, forbearance`;
  }

  getInitialPhase(): string { return 'greeting'; }

  getGreeting(_dir: 'inbound' | 'outbound', name?: string): string {
    return name
      ? `Thank you for calling Calculus Loan Services. I'm your AI assistant. Hi ${name} — do you have your loan number handy?`
      : `Thank you for calling Calculus Loan Services. I'm your AI assistant. Do you have your loan number, or can I look you up by property address?`;
  }

  getClosing(): string {
    return `Is there anything else about your loan I can help with? Thank you for calling Calculus Loan Services.`;
  }

  getEscalationMessage(): string {
    return `Let me connect you with a loan servicing specialist. One moment please.`;
  }
}

// ============================================================================
// IFSE Flow — Treasury Operations
// ============================================================================

/**
 * IFSE Flow — Institutional Financial Services & Exchange
 *
 * Wire status, FX exposure, reconciliation, correspondent banking.
 * Internal-facing, high-auth-tier, precision-critical.
 *
 * Phases: greeting → authenticate → wire_status|fx_operations|reconciliation → close
 */

export class IFSEFlowController extends BaseFlowController {
  readonly model: AgentModel = 'IFSE';
  readonly agentName = 'IFSE Treasury Operations';
  readonly voiceId = 'b5c6d7e8-f9a0-1b2c-3d4e-5f6a7b8c9d0e';
  readonly crmTarget: 'hubspot' = 'hubspot';

  readonly phases: ConversationPhase[] = [
    {
      id: 'greeting', label: 'Greeting', minAuthTier: 0, tools: [],
      preferredProvider: 'gpt-4o', maxTurns: 2, timeoutPhase: 'authenticate',
      systemPromptSegment: `This is the IFSE Treasury Operations line. Verify the caller's authorization immediately — this is a restricted-access system for authorized treasury personnel only.`,
    },
    {
      id: 'authenticate', label: 'Authorization', minAuthTier: 0,
      tools: ['auth_verifyPhone', 'auth_requestOTP', 'auth_verifyOTP'],
      preferredProvider: 'gpt-4o', maxTurns: 6, timeoutPhase: 'escalate',
      systemPromptSegment: `Verify treasury authorization. Require both phone match AND OTP for any access. This is a high-security line — no exceptions.`,
    },
    {
      id: 'wire_status', label: 'Wire Operations', minAuthTier: 2,
      tools: ['ifse_getWireStatus', 'ifse_initiateWire', 'ifse_getWireQueue', 'ifse_getCorrespondentBanks'],
      preferredProvider: 'claude', requiresConfirmation: true,
      systemPromptSegment: `Handle wire transfer operations. For status: provide wire reference, amount, status (pending, processing, completed, returned), and expected completion. For new wires: collect beneficiary, amount, currency, purpose, and routing. DUAL CONTROL: Wires over $50,000 require verbal confirmation of the authorization code.`,
    },
    {
      id: 'fx_operations', label: 'FX Operations', minAuthTier: 2,
      tools: ['ifse_getFXRate', 'ifse_getFXExposure', 'ifse_executeFXTrade', 'ifse_getPositions'],
      preferredProvider: 'claude', requiresConfirmation: true,
      systemPromptSegment: `Handle foreign exchange operations. Provide current rates, exposure summaries, and position reports. For trades: quote the rate, confirm amount and currency pair, and execute on verbal confirmation. All FX trades are recorded for compliance.`,
    },
    {
      id: 'reconciliation', label: 'Reconciliation', minAuthTier: 2,
      tools: ['ifse_getReconStatus', 'ifse_getExceptions', 'ifse_resolveException', 'ifse_getBalanceSheet'],
      preferredProvider: 'claude',
      systemPromptSegment: `Assist with reconciliation. Provide: reconciliation status by account, open exceptions with aging, break details, and resolution options. For resolved items, confirm the adjustment entry.`,
    },
    {
      id: 'reporting', label: 'Treasury Reports', minAuthTier: 2,
      tools: ['ifse_getLiquidityReport', 'ifse_getCashPosition', 'ifse_getCounterpartyExposure'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Generate treasury reports on demand: daily cash position, liquidity coverage ratio, counterparty exposure, and FX position summary. Present figures precisely — treasury operations require exact numbers.`,
    },
    {
      id: 'close', label: 'Closing', minAuthTier: 0, tools: ['crm_logInteraction'],
      preferredProvider: 'gpt-4o', maxTurns: 2,
      systemPromptSegment: `Confirm all actions taken with reference numbers. This is an audited system — every action is logged.`,
    },
    {
      id: 'escalate', label: 'Transfer to Treasury', minAuthTier: 0,
      tools: ['transfer_toAgent'],
      preferredProvider: 'gpt-4o', maxTurns: 2,
      systemPromptSegment: `Transfer to treasury operations desk. Summarize the request and urgency level.`,
    },
  ];

  readonly transitions: PhaseTransition[] = [
    { from: 'greeting', to: 'authenticate', condition: { type: 'always' }, priority: 10 },
    { from: 'authenticate', to: 'wire_status', condition: { type: 'auth_upgrade', tier: 2 }, priority: 10 },
    { from: 'authenticate', to: 'escalate', condition: { type: 'escalation', reason: 'auth_failed' }, priority: 20 },
    { from: 'wire_status', to: 'fx_operations', condition: { type: 'intent_any', intents: ['fx_rate', 'fx_trade', 'fx_exposure'] }, priority: 15 },
    { from: 'wire_status', to: 'reconciliation', condition: { type: 'intent', intent: 'reconciliation' }, priority: 15 },
    { from: 'wire_status', to: 'reporting', condition: { type: 'intent', intent: 'reporting' }, priority: 15 },
    { from: 'wire_status', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'fx_operations', to: 'wire_status', condition: { type: 'intent', intent: 'wire_status' }, priority: 15 },
    { from: 'fx_operations', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'reconciliation', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'reporting', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
  ];

  protected getModelPromptHeader(): string {
    return `AGENT: ${this.agentName}\nMODEL: IFSE — Institutional Financial Services & Exchange\nSECURITY LEVEL: HIGH — All operations logged, dual control for wires >$50K\nSERVICES: Wire operations, FX trading, reconciliation, treasury reporting`;
  }

  getInitialPhase(): string { return 'greeting'; }

  getGreeting(): string {
    return `IFSE Treasury Operations. Please identify yourself for authorization.`;
  }

  getClosing(): string {
    return `All actions have been logged. Is there anything else for treasury operations today?`;
  }

  getEscalationMessage(): string {
    return `Connecting to the treasury operations desk now.`;
  }
}
