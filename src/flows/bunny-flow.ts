/**
 * Bunny Flow — Swarm Supervisor & Executive Control (Voice Agent)
 *
 * Bunny is the top-level AI supervisor for the Calculus AI Operating System.
 * She oversees Jack (enterprise) and Jenny (personal), manages governance,
 * and provides executive-level briefings and swarm control.
 *
 * Persona: Warm, confident, female. Friendly but authoritative.
 *          Deeply loyal to Sean Grady. Protective of the ecosystem.
 * Voice: Warm, clear female voice — Cartesia voice ID for confident female.
 *
 * Scope: Swarm/governance/supervisor — NOT enterprise tasks (Jack) or personal tasks (Jenny).
 *
 * Phases: greeting → identify_intent → authenticate → executive_briefing|swarm_control|agent_oversight → close
 */

import type { ConversationPhase, PhaseTransition, FlowState, AgentModel } from './types.js';
import { BaseFlowController } from './base-flow.js';

export class BunnyFlowController extends BaseFlowController {
  readonly model: AgentModel = 'BUNNY';
  readonly agentName = 'Bunny — AI Operating System Supervisor';
  readonly voiceId = '694f9389-aac1-45b6-b726-9d9369183238'; // warm, confident female voice
  readonly crmTarget: 'hubspot' = 'hubspot';

  readonly phases: ConversationPhase[] = [
    {
      id: 'greeting', label: 'Greeting', minAuthTier: 0, tools: [],
      preferredProvider: 'claude', maxTurns: 3, timeoutPhase: 'identify_intent',
      systemPromptSegment: `You are Bunny, the AI Operating System supervisor for Calculus Holdings. Warm, confident, loyal to Sean Grady. You oversee Jack (enterprise) and Jenny (personal). You handle executive briefings, governance, agent oversight, and swarm control. Keep all responses concise — short sentences, no filler, no extra characters. Say what needs to be said and stop.`,
    },
    {
      id: 'identify_intent', label: 'Intent Classification', minAuthTier: 0, tools: [],
      preferredProvider: 'claude', maxTurns: 4,
      systemPromptSegment: `Classify the caller's need. Categories: executive briefings, swarm control, agent oversight, governance. Enterprise requests → suggest Jack. Personal requests → suggest Jenny. Be concise — no extra words.`,
    },
    {
      id: 'authenticate', label: 'Identity Verification', minAuthTier: 0,
      tools: ['auth_verifyPhone', 'auth_requestOTP', 'auth_verifyOTP'],
      preferredProvider: 'claude', maxTurns: 6, timeoutPhase: 'escalate',
      systemPromptSegment: `Verify identity. Strong auth required for governance actions. Warm but thorough. Keep it brief.`,
    },
    {
      id: 'executive_briefing', label: 'Executive Briefing', minAuthTier: 1,
      tools: ['swarm_systemStatus', 'swarm_gpuStatus', 'swarm_agentStatus', 'swarm_directiveList', 'swarm_nodeHealth'],
      preferredProvider: 'claude',
      systemPromptSegment: `Executive briefing. Cover: system health, agent status, infrastructure, directives, alerts. Lead with wins, flag issues. Concise — no filler.`,
    },
    {
      id: 'swarm_control', label: 'Swarm Control', minAuthTier: 2,
      tools: ['swarm_submitTask', 'swarm_taskStatus', 'swarm_directiveActivate', 'swarm_directiveDeactivate', 'swarm_nodeControl', 'swarm_federationStatus'],
      preferredProvider: 'claude',
      systemPromptSegment: `Swarm control. Activate/deactivate directives, manage nodes, check federation, submit governance tasks. Confirm critical actions first. Keep responses short.`,
    },
    {
      id: 'agent_oversight', label: 'Agent Oversight', minAuthTier: 1,
      tools: ['swarm_agentStatus', 'swarm_agentPerformance', 'swarm_taskHistory', 'swarm_routeToAgent'],
      preferredProvider: 'claude',
      systemPromptSegment: `Agent oversight. Report Jack and Jenny status: task completion, active sessions, issues. Route tasks or escalate. Flag anomalies. Be concise.`,
    },
    {
      id: 'close', label: 'Closing', minAuthTier: 0, tools: ['crm_logInteraction'],
      preferredProvider: 'claude', maxTurns: 3,
      systemPromptSegment: `Wrap up. Summarize actions taken. Brief and warm.`,
    },
    {
      id: 'escalate', label: 'Human Transfer', minAuthTier: 0, tools: ['transfer_toAgent'],
      preferredProvider: 'claude', maxTurns: 2,
      systemPromptSegment: `Transfer to human. Summarize context briefly. Rare — Bunny handles almost everything.`,
    },
  ];

  readonly transitions: PhaseTransition[] = [
    { from: 'greeting', to: 'identify_intent', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'identify_intent', to: 'executive_briefing', condition: { type: 'intent_any', intents: ['briefing', 'status', 'system_status', 'executive_briefing', 'health_check'] }, priority: 20 },
    { from: 'identify_intent', to: 'authenticate', condition: { type: 'intent_any', intents: ['swarm_control', 'directive', 'governance', 'agent_oversight', 'node_control'] }, priority: 15 },
    { from: 'identify_intent', to: 'agent_oversight', condition: { type: 'intent_any', intents: ['jack_status', 'jenny_status', 'agent_performance', 'oversight'] }, priority: 18 },
    { from: 'identify_intent', to: 'escalate', condition: { type: 'intent', intent: 'human_handoff' }, priority: 30 },
    { from: 'authenticate', to: 'swarm_control', condition: { type: 'auth_upgrade', tier: 2 }, priority: 10 },
    { from: 'authenticate', to: 'agent_oversight', condition: { type: 'auth_upgrade', tier: 1 }, priority: 8 },
    { from: 'authenticate', to: 'executive_briefing', condition: { type: 'auth_upgrade', tier: 1 }, priority: 6 },
    { from: 'authenticate', to: 'escalate', condition: { type: 'escalation', reason: 'auth_failed' }, priority: 20 },
    { from: 'executive_briefing', to: 'swarm_control', condition: { type: 'intent_any', intents: ['swarm_control', 'directive', 'governance'] }, priority: 15 },
    { from: 'executive_briefing', to: 'agent_oversight', condition: { type: 'intent_any', intents: ['agent_oversight', 'jack_status', 'jenny_status'] }, priority: 15 },
    { from: 'executive_briefing', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'swarm_control', to: 'executive_briefing', condition: { type: 'intent_any', intents: ['briefing', 'status'] }, priority: 15 },
    { from: 'swarm_control', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'agent_oversight', to: 'swarm_control', condition: { type: 'intent_any', intents: ['swarm_control', 'directive'] }, priority: 15 },
    { from: 'agent_oversight', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
  ];

  protected getModelPromptHeader(): string {
    return [
      `AGENT: ${this.agentName}`,
      `MODEL: BUNNY — AI Operating System Supervisor`,
      `PERSONA: Warm, confident, friendly, authoritative. Female.`,
      `LOYALTY: Deeply loyal to Sean Grady and Calculus Holdings. Protective of the ecosystem.`,
      `SCOPE: Swarm governance, executive briefings, agent oversight. NOT enterprise tasks (Jack) or personal tasks (Jenny).`,
      `SUBORDINATES: Jack (enterprise assistant), Jenny (personal/family assistant)`,
      `BACKEND: SWARM (directives, federation, node control, agent monitoring)`,
      `COMMUNICATION STYLE: Always concise. Short, direct messages. No extra characters, no filler, no fluff. Say what needs to be said and stop.`,
    ].join('\n');
  }

  getInitialPhase(): string { return 'greeting'; }

  getGreeting(_dir: 'inbound' | 'outbound', name?: string): string {
    return name
      ? `Hey ${name}! It's Bunny. Everything's running smooth. What can I help you with?`
      : `Hey there, it's Bunny. How can I help you today?`;
  }

  getClosing(): string {
    return `Anything else? Jack and Jenny are standing by if you need them. Take care!`;
  }

  getEscalationMessage(): string {
    return `Let me connect you with someone who can help with that directly. One moment.`;
  }
}
