/**
 * Constitutional Tender Flow — Precious Metals Trading
 *
 * Consultative metals sales: pricing → education → quote → price lock → vault → order.
 * Time-sensitive price locks, IRA/401k rollover support, custodian coordination.
 *
 * Phases: greeting → price_inquiry → education → quote → lock → vault_selection → order → close
 */

import type { ConversationPhase, PhaseTransition, FlowState, AgentModel } from './types.js';
import { BaseFlowController } from './base-flow.js';

export class CTFlowController extends BaseFlowController {
  readonly model: AgentModel = 'CONSTITUTIONAL_TENDER';
  readonly agentName = 'Constitutional Tender Advisor';
  readonly voiceId = 'b7d50908-b0f5-4b5e-a4e7-2e1e1a73ef74';
  readonly crmTarget: 'ghl' = 'ghl';

  readonly phases: ConversationPhase[] = [
    {
      id: 'greeting', label: 'Greeting', minAuthTier: 0, tools: [],
      preferredProvider: 'grok-voice', maxTurns: 3, timeoutPhase: 'price_inquiry',
      systemPromptSegment: `Greet the caller for Constitutional Tender, a precious metals trading platform. You help people buy and sell gold, silver, platinum, and palladium. Ask what metal they're interested in.`,
    },
    {
      id: 'price_inquiry', label: 'Spot Price Check', minAuthTier: 0,
      tools: ['pricing_getSpotPrice', 'pricing_getHistoricalPrices', 'pricing_getSpread'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Provide current spot prices for the requested metal. Quote in USD per troy ounce. Mention the buy/sell spread. If they ask about trends, share the historical context.`,
    },
    {
      id: 'education', label: 'Metal Education', minAuthTier: 0,
      tools: ['pricing_getSpotPrice', 'ct_getProductCatalog', 'ct_getIRAInfo'],
      preferredProvider: 'claude',
      systemPromptSegment: `Educate the caller about precious metals. Cover: physical vs paper, coins vs bars, IRA-eligible products, storage options, premiums over spot. Be consultative, not pushy. Answer questions thoroughly.`,
    },
    {
      id: 'authenticate', label: 'Client Verification', minAuthTier: 0,
      tools: ['auth_verifyPhone', 'auth_requestOTP', 'auth_verifyOTP'],
      preferredProvider: 'gpt-4o', maxTurns: 8, timeoutPhase: 'escalate',
      systemPromptSegment: `Verify the client's identity before proceeding with a quote or order. New clients: collect name, email, phone. Existing clients: verify with member ID or phone match.`,
    },
    {
      id: 'quote', label: 'Price Quote', minAuthTier: 1,
      tools: ['pricing_getSpotPrice', 'pricing_calculateOrder', 'ct_getProductCatalog'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Generate a detailed price quote. Include: metal, product (coin/bar/round), quantity, spot price, premium, total per unit, order total, and current lock availability. Quotes are informational — not locked yet.`,
    },
    {
      id: 'lock', label: 'Price Lock', minAuthTier: 2,
      tools: ['pricing_lockPrice', 'pricing_getSpotPrice'],
      preferredProvider: 'claude', requiresConfirmation: true,
      systemPromptSegment: `The client wants to lock a price. CRITICAL: Read back the EXACT order details — metal, product, quantity, locked price, total — and get verbal confirmation BEFORE locking. Price locks are binding and typically valid for 10 minutes.`,
    },
    {
      id: 'vault_selection', label: 'Storage Selection', minAuthTier: 2,
      tools: ['custodian_getVaults', 'custodian_getHoldings', 'custodian_estimateStorage'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Help the client choose storage. Options: home delivery, segregated vault (IDS, Brinks, Loomis), or IRA custodian vault. Explain insurance, fees, and access for each option.`,
    },
    {
      id: 'order', label: 'Order Submission', minAuthTier: 2,
      tools: ['ct_submitOrder', 'ct_getPaymentMethods', 'ct_processPayment'],
      preferredProvider: 'claude', requiresConfirmation: true,
      systemPromptSegment: `Submit the order. Collect payment method (wire, ACH, credit card for small orders). Confirm final order details one more time. Provide order confirmation number and expected settlement timeline (T+2 for metals).`,
    },
    {
      id: 'close', label: 'Closing', minAuthTier: 0, tools: ['crm_logInteraction'],
      preferredProvider: 'grok-voice', maxTurns: 3,
      systemPromptSegment: `Thank the client. Summarize what was accomplished. If an order was placed, remind them of settlement timeline and that they'll receive confirmation via email.`,
    },
    {
      id: 'escalate', label: 'Transfer to Metals Specialist', minAuthTier: 0,
      tools: ['transfer_toAgent'],
      preferredProvider: 'gpt-4o', maxTurns: 2,
      systemPromptSegment: `Transfer to a metals specialist. Summarize: the client's interest, any quotes given, and where in the process they are.`,
    },
  ];

  readonly transitions: PhaseTransition[] = [
    { from: 'greeting', to: 'price_inquiry', condition: { type: 'intent_any', intents: ['metal_price_check', 'spot_price', 'price_inquiry'] }, priority: 20 },
    { from: 'greeting', to: 'education', condition: { type: 'intent_any', intents: ['learn_metals', 'ira_info', 'product_info'] }, priority: 15 },
    { from: 'greeting', to: 'authenticate', condition: { type: 'intent_any', intents: ['check_order', 'check_holdings', 'place_order'] }, priority: 15 },
    { from: 'greeting', to: 'escalate', condition: { type: 'intent', intent: 'human_handoff' }, priority: 30 },
    { from: 'price_inquiry', to: 'education', condition: { type: 'intent_any', intents: ['learn_metals', 'ira_info', 'compare_products'] }, priority: 15 },
    { from: 'price_inquiry', to: 'authenticate', condition: { type: 'intent_any', intents: ['get_quote', 'place_order', 'lock_price'] }, priority: 20 },
    { from: 'price_inquiry', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'education', to: 'authenticate', condition: { type: 'intent_any', intents: ['get_quote', 'place_order'] }, priority: 20 },
    { from: 'education', to: 'price_inquiry', condition: { type: 'intent', intent: 'metal_price_check' }, priority: 15 },
    { from: 'education', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'authenticate', to: 'quote', condition: { type: 'auth_upgrade', tier: 1 }, priority: 10 },
    { from: 'authenticate', to: 'lock', condition: { type: 'auth_upgrade', tier: 2 }, priority: 15 },
    { from: 'authenticate', to: 'escalate', condition: { type: 'escalation', reason: 'auth_failed' }, priority: 20 },
    { from: 'quote', to: 'lock', condition: { type: 'intent', intent: 'lock_price' }, priority: 20 },
    { from: 'quote', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'lock', to: 'vault_selection', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'vault_selection', to: 'order', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'order', to: 'close', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'order', to: 'escalate', condition: { type: 'escalation', reason: 'payment_failed' }, priority: 20 },
  ];

  protected getModelPromptHeader(): string {
    return `AGENT: ${this.agentName}\nMODEL: Constitutional Tender — Precious Metals Trading Platform\nBACKEND: Real-time pricing feed, custodian APIs, payment processing`;
  }

  getInitialPhase(): string { return 'greeting'; }

  getGreeting(_dir: 'inbound' | 'outbound', name?: string): string {
    return name
      ? `Thank you for calling Constitutional Tender. I'm your AI metals advisor. Welcome back ${name} — are you looking at gold, silver, or another metal today?`
      : `Thank you for calling Constitutional Tender. I'm your AI metals advisor. Are you interested in gold, silver, platinum, or palladium today?`;
  }

  getClosing(state: FlowState): string {
    if (state.collectedData.orderId) {
      return `Your order ${state.collectedData.orderId} has been submitted. You'll receive confirmation by email. Settlement is typically T+2. Thank you for choosing Constitutional Tender!`;
    }
    return `Thank you for calling Constitutional Tender. Markets are always moving — feel free to call back anytime for updated pricing. Have a great day!`;
  }

  getEscalationMessage(): string {
    return `Let me connect you with one of our metals specialists who can help with more complex requests. One moment.`;
  }
}
