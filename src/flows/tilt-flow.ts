/**
 * TILT Flow — Commercial Bridge & DSCR Lending
 *
 * Structured loan intake: property → financials → pre-screen → term sheet → application.
 * Form-fill conversation that ends with DSCR analysis and lead creation.
 *
 * Phases: greeting → caller_type → property_intake → financial_intake → pre_screen → term_sheet → close
 */

import type { ConversationPhase, PhaseTransition, FlowState, AgentModel } from './types.js';
import { BaseFlowController } from './base-flow.js';

const REQUIRED_FIELDS = [
  'callerType', 'borrowerName', 'propertyType', 'propertyAddress',
  'propertyValue', 'requestedLoanAmount', 'grossRentalIncome',
  'operatingExpenses', 'noi', 'contactPhone', 'contactEmail',
];

export class TILTFlowController extends BaseFlowController {
  readonly model: AgentModel = 'TILT';
  readonly agentName = 'TILT Lending Intake Specialist';
  readonly voiceId = 'c8e4e45f-0e5b-4e2e-a3c8-1a2b3c4d5e6f';
  readonly crmTarget: 'ghl' = 'ghl';

  readonly phases: ConversationPhase[] = [
    {
      id: 'greeting', label: 'Greeting', minAuthTier: 0, tools: [],
      preferredProvider: 'grok-voice', maxTurns: 3, timeoutPhase: 'caller_type',
      systemPromptSegment: `Greet the caller for TILT Lending, a commercial real estate bridge and DSCR loan provider. Ask if they're a broker submitting a deal or a borrower looking for financing.`,
    },
    {
      id: 'caller_type', label: 'Caller Classification', minAuthTier: 0, tools: [],
      preferredProvider: 'gpt-4o', maxTurns: 3,
      systemPromptSegment: `Determine if the caller is a mortgage broker submitting a deal, or a direct borrower. Brokers get a streamlined intake; borrowers get more education about the process.`,
    },
    {
      id: 'property_intake', label: 'Property Information', minAuthTier: 0,
      tools: ['tilt_getLoanPrograms'],
      preferredProvider: 'claude',
      systemPromptSegment: `Collect property details: type (multifamily, mixed-use, office, retail, industrial, hospitality), address, number of units (if applicable), current status (stabilized, value-add, ground-up), and estimated property value. Be conversational — don't read a form.`,
    },
    {
      id: 'financial_intake', label: 'Financial Details', minAuthTier: 0,
      tools: ['tilt_calculateDSCR', 'tilt_getLoanPrograms'],
      preferredProvider: 'claude',
      systemPromptSegment: `Collect financials: gross rental income, operating expenses, NOI (calculate if they give you income and expenses), requested loan amount. For value-add: projected NOI and renovation budget. Calculate preliminary LTV and DSCR as you collect data.`,
    },
    {
      id: 'pre_screen', label: 'Pre-Screen Analysis', minAuthTier: 0,
      tools: ['tilt_calculateDSCR', 'tilt_getLoanPrograms', 'tilt_checkSanctions'],
      preferredProvider: 'claude',
      systemPromptSegment: `Run the pre-screen. Present the results conversationally: "Based on what you've told me, your deal shows a DSCR of X and an LTV of Y. That fits our [program name] program." If marginal, explain what would improve it. If outside parameters, be honest and suggest alternatives.`,
    },
    {
      id: 'term_sheet', label: 'Indicative Term Sheet', minAuthTier: 0,
      tools: ['tilt_generateTermSheet', 'tilt_createLead'],
      preferredProvider: 'claude', requiresConfirmation: true,
      systemPromptSegment: `Present the indicative term sheet: rate range, term, amortization, prepay penalty, origination fee, minimum DSCR, max LTV. This is non-binding. Ask if they'd like to proceed to formal application. Collect contact info (phone, email) and create the lead.`,
    },
    {
      id: 'contact_collect', label: 'Contact Collection', minAuthTier: 0,
      tools: ['tilt_createLead'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Collect the borrower's contact information: full name, phone number, and email address. Let them know their information will be used to send the term sheet and follow up on the application.`,
    },
    {
      id: 'close', label: 'Closing', minAuthTier: 0, tools: ['crm_logInteraction'],
      preferredProvider: 'grok-voice', maxTurns: 3,
      systemPromptSegment: `Summarize the deal: property type, requested amount, preliminary DSCR/LTV, and next steps. Let them know a loan officer will follow up within 24 hours.`,
    },
    {
      id: 'escalate', label: 'Transfer to Loan Officer', minAuthTier: 0,
      tools: ['transfer_toAgent'],
      preferredProvider: 'gpt-4o', maxTurns: 2,
      systemPromptSegment: `Transfer to a loan officer. Summarize: property type, address, loan amount, and any pre-screen results.`,
    },
  ];

  readonly transitions: PhaseTransition[] = [
    { from: 'greeting', to: 'caller_type', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'greeting', to: 'escalate', condition: { type: 'intent', intent: 'human_handoff' }, priority: 30 },
    { from: 'caller_type', to: 'property_intake', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'property_intake', to: 'financial_intake', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'financial_intake', to: 'pre_screen', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'pre_screen', to: 'term_sheet', condition: { type: 'intent', intent: 'proceed' }, priority: 15 },
    { from: 'pre_screen', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'term_sheet', to: 'contact_collect', condition: { type: 'user_confirms' }, priority: 15 },
    { from: 'term_sheet', to: 'close', condition: { type: 'user_declines' }, priority: 10 },
    { from: 'contact_collect', to: 'close', condition: { type: 'phase_complete' }, priority: 10 },
  ];

  protected getModelPromptHeader(): string {
    return `AGENT: ${this.agentName}\nMODEL: TILT — Commercial Bridge & DSCR Lending\nPROGRAMS: Bridge (12-36mo), DSCR Long-Term (5/7/10yr), Fix & Flip, Ground-Up Construction`;
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
      ? `Thank you for calling TILT Lending. I'm your AI intake specialist. Welcome back ${name} — are you submitting a new deal today?`
      : `Thank you for calling TILT Lending. I'm your AI intake specialist. Are you a broker submitting a deal, or a borrower looking for commercial financing?`;
  }

  getClosing(state: FlowState): string {
    const pct = this.getCompletionPercentage(state);
    if (pct >= 80) {
      return `Great — I have everything I need. A loan officer will review your deal and follow up within 24 hours. Thank you for considering TILT Lending!`;
    }
    return `Thank you for calling TILT Lending. Feel free to call back when you have more details on the property. We're here to help.`;
  }

  getEscalationMessage(): string {
    return `Let me connect you directly with one of our loan officers. One moment please.`;
  }
}
