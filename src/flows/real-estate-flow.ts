/**
 * Real Estate Flow — Transaction Coordination
 *
 * Multi-party coordination: listing inquiries, offer management,
 * showing scheduling, contract-to-close tracking, document collection.
 *
 * Phases: greeting → inquiry_type → property_search|offer_mgmt|showing|status → close
 */

import type { ConversationPhase, PhaseTransition, FlowState, AgentModel } from './types.js';
import { BaseFlowController } from './base-flow.js';

export class RealEstateFlowController extends BaseFlowController {
  readonly model: AgentModel = 'REAL_ESTATE';
  readonly agentName = 'Calculus Real Estate Coordinator';
  readonly voiceId = 'e2f3a4b5-c6d7-8e9f-0a1b-2c3d4e5f6a7b';
  readonly crmTarget: 'ghl' = 'ghl';

  readonly phases: ConversationPhase[] = [
    {
      id: 'greeting', label: 'Greeting', minAuthTier: 0, tools: [],
      preferredProvider: 'grok-voice', maxTurns: 3, timeoutPhase: 'inquiry_type',
      systemPromptSegment: `Greet the caller for Calculus Real Estate. Ask if they're a buyer, seller, agent calling about a transaction, or checking on an existing deal.`,
    },
    {
      id: 'inquiry_type', label: 'Inquiry Classification', minAuthTier: 0, tools: [],
      preferredProvider: 'gpt-4o', maxTurns: 3,
      systemPromptSegment: `Classify the caller's need: property search/listing inquiry, submitting or checking an offer, scheduling a showing, transaction status update, or document questions.`,
    },
    {
      id: 'property_search', label: 'Property Search', minAuthTier: 0,
      tools: ['re_searchListings', 're_getPropertyDetails', 're_getComparables'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Help the caller find properties. Collect criteria: location/neighborhood, price range, property type, bedrooms/bathrooms, must-haves. Present matches with key details: address, price, beds/baths, square footage, days on market. Offer to schedule showings.`,
    },
    {
      id: 'offer_management', label: 'Offer Management', minAuthTier: 1,
      tools: ['re_submitOffer', 're_getOfferStatus', 're_counterOffer', 're_getComparables'],
      preferredProvider: 'claude', requiresConfirmation: true,
      systemPromptSegment: `Handle offer submission or management. For new offers: collect price, contingencies (inspection, financing, appraisal), earnest money, closing date, and any special terms. For existing offers: check status, relay counteroffers, discuss terms. ALWAYS confirm offer details before submitting.`,
    },
    {
      id: 'showing', label: 'Showing Coordination', minAuthTier: 0,
      tools: ['re_scheduleShowing', 're_getAvailability', 're_cancelShowing'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Schedule property showings. Check availability for the requested property and time. Confirm: property address, date, time, and attendees. Send confirmation to all parties.`,
    },
    {
      id: 'transaction_status', label: 'Transaction Status', minAuthTier: 1,
      tools: ['re_getTransactionStatus', 're_getDocumentChecklist', 're_getTimeline'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Provide transaction status updates. Cover: current milestone (under contract, inspection, appraisal, clear to close), pending items, key dates, and any outstanding conditions. Be specific about what's needed and from whom.`,
    },
    {
      id: 'document_collection', label: 'Document Collection', minAuthTier: 1,
      tools: ['re_getDocumentChecklist', 're_requestDocument', 're_uploadStatus'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Help with document collection for the transaction. Review what's been received, what's outstanding, and deadlines. Explain what each document is and why it's needed.`,
    },
    {
      id: 'authenticate', label: 'Identity Verification', minAuthTier: 0,
      tools: ['auth_verifyPhone', 'auth_requestOTP', 'auth_verifyOTP'],
      preferredProvider: 'gpt-4o', maxTurns: 8, timeoutPhase: 'escalate',
      systemPromptSegment: `Verify identity for transaction access. Collect name and verify via phone match or OTP.`,
    },
    {
      id: 'close', label: 'Closing', minAuthTier: 0, tools: ['crm_logInteraction'],
      preferredProvider: 'grok-voice', maxTurns: 3,
      systemPromptSegment: `Wrap up. Summarize any actions taken, next steps, and relevant dates.`,
    },
    {
      id: 'escalate', label: 'Transfer to Agent', minAuthTier: 0,
      tools: ['transfer_toAgent'],
      preferredProvider: 'gpt-4o', maxTurns: 2,
      systemPromptSegment: `Transfer to a real estate agent or transaction coordinator. Summarize the caller's need and any relevant transaction details.`,
    },
  ];

  readonly transitions: PhaseTransition[] = [
    { from: 'greeting', to: 'inquiry_type', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'greeting', to: 'escalate', condition: { type: 'intent', intent: 'human_handoff' }, priority: 30 },
    { from: 'inquiry_type', to: 'property_search', condition: { type: 'intent_any', intents: ['property_search', 'listing_inquiry'] }, priority: 20 },
    { from: 'inquiry_type', to: 'authenticate', condition: { type: 'intent_any', intents: ['submit_offer', 'check_offer', 'transaction_status', 'documents'] }, priority: 15 },
    { from: 'inquiry_type', to: 'showing', condition: { type: 'intent', intent: 'schedule_showing' }, priority: 20 },
    { from: 'authenticate', to: 'offer_management', condition: { type: 'auth_upgrade', tier: 1 }, priority: 10 },
    { from: 'authenticate', to: 'transaction_status', condition: { type: 'auth_upgrade', tier: 1 }, priority: 10 },
    { from: 'authenticate', to: 'escalate', condition: { type: 'escalation', reason: 'auth_failed' }, priority: 20 },
    { from: 'property_search', to: 'showing', condition: { type: 'intent', intent: 'schedule_showing' }, priority: 15 },
    { from: 'property_search', to: 'authenticate', condition: { type: 'intent', intent: 'submit_offer' }, priority: 15 },
    { from: 'property_search', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'offer_management', to: 'close', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'showing', to: 'close', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'transaction_status', to: 'document_collection', condition: { type: 'intent', intent: 'documents' }, priority: 15 },
    { from: 'transaction_status', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'document_collection', to: 'close', condition: { type: 'phase_complete' }, priority: 10 },
  ];

  protected getModelPromptHeader(): string {
    return `AGENT: ${this.agentName}\nMODEL: Real Estate Transaction Coordination\nSERVICES: Property search, offer management, showing coordination, contract-to-close tracking`;
  }

  getInitialPhase(): string { return 'greeting'; }

  getGreeting(_dir: 'inbound' | 'outbound', name?: string): string {
    return name
      ? `Thank you for calling Calculus Real Estate. I'm your AI coordinator. Hi ${name} — are you calling about a property or an existing transaction?`
      : `Thank you for calling Calculus Real Estate. I'm your AI coordinator. Are you a buyer looking for properties, or calling about an existing transaction?`;
  }

  getClosing(): string {
    return `Is there anything else I can help with? Thank you for choosing Calculus Real Estate. Have a great day!`;
  }

  getEscalationMessage(): string {
    return `Let me connect you with one of our real estate agents. One moment please.`;
  }
}
