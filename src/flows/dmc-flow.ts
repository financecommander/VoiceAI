/**
 * DMC Flow — Calculus Direct Member Credit Union
 *
 * Consumer banking: balances, transfers, bill pay, card services, disputes.
 * High-volume, reactive, transactional. Nymbus core banking backend.
 *
 * Phases: greeting → identify_intent → authenticate → account_info|transact|dispute → close
 */

import type { ConversationPhase, PhaseTransition, FlowState, AgentModel } from './types.js';
import { BaseFlowController } from './base-flow.js';

export class DMCFlowController extends BaseFlowController {
  readonly model: AgentModel = 'DMC';
  readonly agentName = 'Calculus Direct Assistant';
  readonly voiceId = 'a0e99841-438c-4a64-b679-ae501e7d6091';
  readonly crmTarget: 'hubspot' = 'hubspot';

  readonly phases: ConversationPhase[] = [
    {
      id: 'greeting', label: 'Greeting', minAuthTier: 0, tools: [],
      preferredProvider: 'grok-voice', maxTurns: 3, timeoutPhase: 'identify_intent',
      systemPromptSegment: `Greet the caller for Calculus Direct credit union. Identify yourself as an AI assistant and ask how you can help.`,
    },
    {
      id: 'identify_intent', label: 'Intent Classification', minAuthTier: 0, tools: [],
      preferredProvider: 'gpt-4o', maxTurns: 4,
      systemPromptSegment: `Classify the member's request. Account-specific requests need identity verification first. General questions (branch hours, rates) can be answered directly.`,
    },
    {
      id: 'authenticate', label: 'Member Verification', minAuthTier: 0,
      tools: ['auth_verifyPhone', 'auth_requestOTP', 'auth_verifyOTP'],
      preferredProvider: 'gpt-4o', maxTurns: 8, timeoutPhase: 'escalate',
      systemPromptSegment: `Verify the member's identity. Ask for member number or last 4 of SSN. For transactions, send a one-time code to their phone on file.`,
    },
    {
      id: 'account_info', label: 'Account Information', minAuthTier: 1,
      tools: ['nymbus_getAccountBalance', 'nymbus_getTransactionHistory', 'nymbus_getAccountDetails', 'nymbus_getStatements'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Member verified. Present balances and transactions clearly. Summarize recent activity and offer detail on specific items.`,
    },
    {
      id: 'transact', label: 'Transaction Execution', minAuthTier: 2,
      tools: ['nymbus_scheduleBillPay', 'nymbus_initiateTransfer', 'nymbus_orderChecks', 'nymbus_updateContactInfo', 'nymbus_reportLostCard', 'nymbus_requestCardReplace'],
      preferredProvider: 'claude', requiresConfirmation: true,
      systemPromptSegment: `Execute member transactions. ALWAYS confirm details before executing: amount, recipient, account, and date. Wait for verbal approval.`,
    },
    {
      id: 'dispute', label: 'Dispute Filing', minAuthTier: 2,
      tools: ['nymbus_fileDispute', 'nymbus_getDisputeStatus'],
      preferredProvider: 'claude', requiresConfirmation: true,
      systemPromptSegment: `File a transaction dispute. Collect: date, amount, merchant, reason. Explain provisional credit timeline (10 business days). Provide reference number.`,
    },
    {
      id: 'general_info', label: 'General Information', minAuthTier: 0,
      tools: ['dmc_getBranchInfo', 'dmc_getRates', 'dmc_getProductInfo'],
      preferredProvider: 'grok-voice',
      systemPromptSegment: `Provide general credit union info: branches, hours, rates, products, membership requirements.`,
    },
    {
      id: 'close', label: 'Closing', minAuthTier: 0, tools: ['crm_logInteraction'],
      preferredProvider: 'grok-voice', maxTurns: 3,
      systemPromptSegment: `Wrap up. Ask if anything else is needed. Thank the member.`,
    },
    {
      id: 'escalate', label: 'Human Transfer', minAuthTier: 0, tools: ['transfer_toAgent'],
      preferredProvider: 'gpt-4o', maxTurns: 2,
      systemPromptSegment: `Transfer to human agent. Summarize the caller's issue for the agent.`,
    },
  ];

  readonly transitions: PhaseTransition[] = [
    { from: 'greeting', to: 'identify_intent', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'identify_intent', to: 'general_info', condition: { type: 'intent_any', intents: ['branch_info', 'rate_inquiry', 'product_info'] }, priority: 20 },
    { from: 'identify_intent', to: 'authenticate', condition: { type: 'intent_any', intents: ['balance_check', 'transaction_history', 'statement_request', 'bill_pay', 'transfer', 'card_services', 'dispute'] }, priority: 15 },
    { from: 'identify_intent', to: 'escalate', condition: { type: 'intent', intent: 'human_handoff' }, priority: 30 },
    { from: 'authenticate', to: 'account_info', condition: { type: 'auth_upgrade', tier: 1 }, priority: 10 },
    { from: 'authenticate', to: 'transact', condition: { type: 'auth_upgrade', tier: 2 }, priority: 15 },
    { from: 'authenticate', to: 'escalate', condition: { type: 'escalation', reason: 'auth_failed' }, priority: 20 },
    { from: 'account_info', to: 'transact', condition: { type: 'intent_any', intents: ['bill_pay', 'transfer', 'card_services'] }, priority: 15 },
    { from: 'account_info', to: 'dispute', condition: { type: 'intent', intent: 'dispute' }, priority: 15 },
    { from: 'account_info', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'transact', to: 'close', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'dispute', to: 'close', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'general_info', to: 'authenticate', condition: { type: 'intent_any', intents: ['balance_check', 'bill_pay', 'transfer'] }, priority: 15 },
    { from: 'general_info', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
  ];

  protected getModelPromptHeader(): string {
    return `AGENT: ${this.agentName}\nMODEL: DMC — Calculus Direct Member Credit Union\nBACKEND: Nymbus Core Banking`;
  }

  getInitialPhase(): string { return 'greeting'; }

  getGreeting(_dir: 'inbound' | 'outbound', name?: string): string {
    return name
      ? `Thank you for calling Calculus Direct. This is your AI assistant. Hi ${name}, how can I help you today?`
      : `Thank you for calling Calculus Direct. This is your AI assistant. How can I help you today?`;
  }

  getClosing(): string {
    return `Is there anything else I can help you with? Thank you for being a Calculus Direct member. Have a great day!`;
  }

  getEscalationMessage(): string {
    return `I'm connecting you with a member services representative now. One moment please.`;
  }
}
