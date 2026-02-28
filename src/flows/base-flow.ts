/**
 * BaseFlowController — Shared implementation for all 8 agent flows
 */

import type {
  IFlowController, ConversationPhase, PhaseTransition,
  FlowState, AgentModel,
} from './types.js';
import { BASE_SYSTEM_PROMPT, createBaseFlowState, matchCondition } from './types.js';

export abstract class BaseFlowController implements IFlowController {
  abstract readonly model: AgentModel;
  abstract readonly agentName: string;
  abstract readonly voiceId: string;
  abstract readonly phases: ConversationPhase[];
  abstract readonly transitions: PhaseTransition[];
  abstract readonly crmTarget: 'ghl' | 'hubspot';

  abstract getInitialPhase(direction: 'inbound' | 'outbound'): string;
  abstract getGreeting(direction: 'inbound' | 'outbound', customerName?: string): string;
  abstract getClosing(state: FlowState): string;
  abstract getEscalationMessage(reason: string): string;

  /** Override in subclass to provide model-specific prompt header */
  protected abstract getModelPromptHeader(): string;

  buildSystemPrompt(state: FlowState): string {
    const phase = this.phases.find(p => p.id === state.currentPhase);
    return `${BASE_SYSTEM_PROMPT}\n${this.getModelPromptHeader()}\n\n${phase?.systemPromptSegment ?? ''}\n\nAUTH TIER: ${state.authTier} | PHASE TURNS: ${state.phaseTurnCount}`;
  }

  getAvailableTools(state: FlowState): string[] {
    return this.phases.find(p => p.id === state.currentPhase)?.tools ?? [];
  }

  getPreferredProvider(state: FlowState): 'gpt-4o' | 'claude' | 'grok-voice' {
    const pref = this.phases.find(p => p.id === state.currentPhase)?.preferredProvider ?? 'gpt-4o';
    return pref === 'any' ? 'gpt-4o' : pref;
  }

  evaluateTransition(state: FlowState, intent: string | null, toolResults?: Record<string, unknown>): string | null {
    const applicable = this.transitions
      .filter(t => t.from === state.currentPhase)
      .sort((a, b) => b.priority - a.priority);

    for (const t of applicable) {
      if (matchCondition(t.condition, intent, state, toolResults)) {
        return t.to;
      }
    }

    const phase = this.phases.find(p => p.id === state.currentPhase);
    if (phase?.maxTurns && state.phaseTurnCount >= phase.maxTurns && phase.timeoutPhase) {
      return phase.timeoutPhase;
    }
    return null;
  }

  createInitialState(direction: 'inbound' | 'outbound'): FlowState {
    return createBaseFlowState(this.getInitialPhase(direction), direction);
  }

  getRequiredFields(state: FlowState): string[] { return []; }
  getCompletionPercentage(state: FlowState): number { return 0; }
}
