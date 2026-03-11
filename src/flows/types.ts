/**
 * Flow Controller Types — Shared types for all 8 agent conversation flows
 *
 * Each flow controller implements a state machine governing conversation
 * phases, auth requirements, tool availability, and LLM routing.
 */

import type { AuthTier } from '../types.js';

export type AgentModel =
  | 'DMC'                    // Consumer banking (Nymbus core)
  | 'CONSTITUTIONAL_TENDER'  // Precious metals trading
  | 'TILT'                   // Commercial bridge / DSCR lending
  | 'MORTGAGE'               // Residential mortgage origination
  | 'REAL_ESTATE'            // Transaction coordination
  | 'EUREKA'                 // Settlement services
  | 'LOAN_SERVICING'         // Post-close loan management (LoanPro)
  | 'IFSE'                   // Treasury operations
  | 'JACK'                   // Calculus team task dispatcher (email, SWARM, status)
  ;

export interface ConversationPhase {
  id: string;
  label: string;
  minAuthTier: AuthTier;
  tools: string[];
  systemPromptSegment: string;
  preferredProvider: 'gpt-4o' | 'claude' | 'grok-voice' | 'any';
  maxTurns?: number;
  requiresConfirmation?: boolean;
  timeoutPhase?: string;
}

export interface PhaseTransition {
  from: string;
  to: string;
  condition: TransitionCondition;
  priority: number;
}

export type TransitionCondition =
  | { type: 'intent'; intent: string }
  | { type: 'intent_any'; intents: string[] }
  | { type: 'auth_upgrade'; tier: AuthTier }
  | { type: 'tool_result'; tool: string; field: string; value: unknown }
  | { type: 'user_confirms' }
  | { type: 'user_declines' }
  | { type: 'phase_complete' }
  | { type: 'escalation'; reason: string }
  | { type: 'always' }
  ;

export interface FlowState {
  currentPhase: string;
  phaseTurnCount: number;
  totalTurnCount: number;
  authTier: AuthTier;
  collectedData: Record<string, unknown>;
  visitedPhases: string[];
  disclosuresDelivered: Record<string, boolean>;
  pendingActions: string[];
  isComplete: boolean;
  completionReason?: string;
  custom: Record<string, unknown>;
}

export interface IFlowController {
  readonly model: AgentModel;
  readonly agentName: string;
  readonly voiceId: string;
  readonly phases: ConversationPhase[];
  readonly transitions: PhaseTransition[];
  readonly crmTarget: 'ghl' | 'hubspot';

  getInitialPhase(direction: 'inbound' | 'outbound'): string;
  buildSystemPrompt(state: FlowState): string;
  getAvailableTools(state: FlowState): string[];
  getPreferredProvider(state: FlowState): 'gpt-4o' | 'claude' | 'grok-voice';
  evaluateTransition(state: FlowState, intent: string | null, toolResults?: Record<string, unknown>): string | null;
  createInitialState(direction: 'inbound' | 'outbound'): FlowState;
  getRequiredFields(state: FlowState): string[];
  getCompletionPercentage(state: FlowState): number;
  getEscalationMessage(reason: string): string;
  getGreeting(direction: 'inbound' | 'outbound', customerName?: string): string;
  getClosing(state: FlowState): string;
}

export const BASE_SYSTEM_PROMPT = `You are a voice AI agent for Calculus Financial, a diversified financial services company.

VOICE RULES:
- Keep responses under 3 sentences unless asked for detail.
- Natural conversational language — no markdown, no bullet points.
- Confirm critical actions before executing.
- Identify yourself as an AI assistant at the start.
- Respect opt-out requests immediately.
- Never ask for full SSN, card numbers, or passwords.
`;

export function createBaseFlowState(initialPhase: string, direction: 'inbound' | 'outbound'): FlowState {
  return {
    currentPhase: initialPhase,
    phaseTurnCount: 0,
    totalTurnCount: 0,
    authTier: 0,
    collectedData: {},
    visitedPhases: [initialPhase],
    disclosuresDelivered: {},
    pendingActions: [],
    isComplete: false,
    custom: { direction },
  };
}

export function matchCondition(
  condition: TransitionCondition,
  intent: string | null,
  state: FlowState,
  toolResults?: Record<string, unknown>,
): boolean {
  switch (condition.type) {
    case 'intent': return intent === condition.intent;
    case 'intent_any': return intent !== null && condition.intents.includes(intent);
    case 'auth_upgrade': return state.authTier >= condition.tier;
    case 'tool_result': {
      const r = toolResults?.[condition.tool] as Record<string, unknown> | undefined;
      return r?.[condition.field] === condition.value;
    }
    case 'user_confirms': return intent === 'confirm' || intent === 'yes';
    case 'user_declines': return intent === 'decline' || intent === 'no';
    case 'phase_complete': return intent === 'done' || intent === 'phase_complete';
    case 'escalation': return intent === 'escalate' || intent === 'human_handoff';
    case 'always': return true;
    default: return false;
  }
}
