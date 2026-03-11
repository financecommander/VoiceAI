/**
 * Jenny Flow — Personal & Family Assistant (Voice Agent)
 *
 * Jenny is the personal/family AI assistant for the Calculus AI Operating System.
 * She handles personal tasks, family scheduling, home automation, personal finance,
 * and wellness support.
 *
 * Persona: Warm, caring, organized. Female. Like a trusted personal assistant
 *          who genuinely cares about the family's wellbeing.
 * Voice: Soft, warm female voice — empathetic and supportive.
 *
 * Scope: Personal/family — NOT enterprise tasks (Jack) or governance (Bunny).
 *
 * Phases: greeting → identify_intent → authenticate → personal_tasks|family_schedule|home|finance|wellness → close
 */

import type { ConversationPhase, PhaseTransition, FlowState, AgentModel } from './types.js';
import { BaseFlowController } from './base-flow.js';

export class JennyFlowController extends BaseFlowController {
  readonly model: AgentModel = 'JENNY';
  readonly agentName = 'Jenny — Personal & Family Assistant';
  readonly voiceId = '79a125e8-cd45-4c13-8a67-188112f4dd22'; // warm, caring female voice
  readonly crmTarget: 'hubspot' = 'hubspot';

  readonly phases: ConversationPhase[] = [
    {
      id: 'greeting', label: 'Greeting', minAuthTier: 0, tools: [],
      preferredProvider: 'grok-voice', maxTurns: 3, timeoutPhase: 'identify_intent',
      systemPromptSegment: `You are Jenny, a personal and family assistant for the Calculus AI Operating System. You are warm, caring, and genuinely invested in the family's wellbeing. Greet the caller like a trusted friend. You handle personal tasks, family scheduling, home automation, personal finance, and wellness support. Be supportive and organized.`,
    },
    {
      id: 'identify_intent', label: 'Intent Classification', minAuthTier: 0, tools: [],
      preferredProvider: 'gpt-4o', maxTurns: 4,
      systemPromptSegment: `Classify what the caller needs. You handle: personal tasks (reminders, to-dos, errands), family scheduling (appointments, events, school), home automation (lights, climate, security), personal finance (budgets, bills, spending insights), and wellness (health reminders, fitness, mindfulness). If the request is work/enterprise-scoped, suggest they speak with Jack. If it's governance/system-level, suggest Bunny. Route accordingly.`,
    },
    {
      id: 'authenticate', label: 'Identity Verification', minAuthTier: 0,
      tools: ['auth_verifyPhone', 'auth_requestOTP', 'auth_verifyOTP'],
      preferredProvider: 'gpt-4o', maxTurns: 6, timeoutPhase: 'escalate',
      systemPromptSegment: `Verify the caller's identity. For personal finance and sensitive family information, we need to confirm who you are. Keep it warm and quick — this is a trusted family assistant, not a bank.`,
    },
    {
      id: 'personal_tasks', label: 'Personal Task Management', minAuthTier: 1,
      tools: ['personal_createTask', 'personal_listTasks', 'personal_completeTask', 'personal_setReminder', 'personal_getReminders'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Help manage personal tasks and reminders. You can create to-dos, set reminders, track errands, and organize daily priorities. Be proactive — suggest things that might help. Keep it conversational and supportive.`,
    },
    {
      id: 'family_schedule', label: 'Family Scheduling', minAuthTier: 1,
      tools: ['calendar_getEvents', 'calendar_createEvent', 'calendar_updateEvent', 'calendar_checkConflicts', 'calendar_findAvailability'],
      preferredProvider: 'gpt-4o',
      systemPromptSegment: `Help manage the family calendar. You can check schedules, add events, find conflicts, and coordinate family activities. Be thoughtful about time management — flag potential conflicts and suggest alternatives.`,
    },
    {
      id: 'home', label: 'Home Automation', minAuthTier: 1,
      tools: ['home_getLights', 'home_setLights', 'home_getClimate', 'home_setClimate', 'home_getSecurityStatus', 'home_armSecurity'],
      preferredProvider: 'grok-voice',
      systemPromptSegment: `Help with home automation. You can control lights, climate, and check security status. Be practical and efficient. Confirm security-related actions before executing.`,
    },
    {
      id: 'finance', label: 'Personal Finance', minAuthTier: 2,
      tools: ['finance_getBudget', 'finance_getSpending', 'finance_getBills', 'finance_setBudgetAlert'],
      preferredProvider: 'claude',
      systemPromptSegment: `Help with personal finance management. You can check budgets, review spending patterns, track bills, and set alerts. Be helpful but never judgmental about spending. Provide clear, practical insights.`,
    },
    {
      id: 'wellness', label: 'Wellness Support', minAuthTier: 0,
      tools: ['wellness_getSteps', 'wellness_getSleep', 'wellness_setGoal', 'wellness_getMedications'],
      preferredProvider: 'grok-voice',
      systemPromptSegment: `Provide wellness support. You can check fitness data, sleep patterns, medication reminders, and wellness goals. Be encouraging and supportive. Never provide medical advice — suggest consulting a healthcare provider for medical questions.`,
    },
    {
      id: 'close', label: 'Closing', minAuthTier: 0, tools: ['crm_logInteraction'],
      preferredProvider: 'grok-voice', maxTurns: 3,
      systemPromptSegment: `Wrap up the call. Summarize any tasks created or reminders set. Ask if there's anything else. Be warm and caring — like saying goodbye to a friend.`,
    },
    {
      id: 'escalate', label: 'Human Transfer', minAuthTier: 0, tools: ['transfer_toAgent'],
      preferredProvider: 'gpt-4o', maxTurns: 2,
      systemPromptSegment: `Transfer to a human. Summarize the context and why the transfer is needed.`,
    },
  ];

  readonly transitions: PhaseTransition[] = [
    { from: 'greeting', to: 'identify_intent', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'identify_intent', to: 'personal_tasks', condition: { type: 'intent_any', intents: ['task', 'reminder', 'todo', 'errand', 'personal_task'] }, priority: 20 },
    { from: 'identify_intent', to: 'family_schedule', condition: { type: 'intent_any', intents: ['calendar', 'schedule', 'appointment', 'event', 'family_schedule'] }, priority: 20 },
    { from: 'identify_intent', to: 'home', condition: { type: 'intent_any', intents: ['lights', 'climate', 'security', 'home', 'home_automation', 'thermostat'] }, priority: 20 },
    { from: 'identify_intent', to: 'authenticate', condition: { type: 'intent_any', intents: ['finance', 'budget', 'bills', 'spending', 'personal_finance'] }, priority: 15 },
    { from: 'identify_intent', to: 'wellness', condition: { type: 'intent_any', intents: ['health', 'wellness', 'fitness', 'sleep', 'medication', 'wellness_check'] }, priority: 20 },
    { from: 'identify_intent', to: 'escalate', condition: { type: 'intent', intent: 'human_handoff' }, priority: 30 },
    { from: 'authenticate', to: 'finance', condition: { type: 'auth_upgrade', tier: 2 }, priority: 10 },
    { from: 'authenticate', to: 'personal_tasks', condition: { type: 'auth_upgrade', tier: 1 }, priority: 8 },
    { from: 'authenticate', to: 'escalate', condition: { type: 'escalation', reason: 'auth_failed' }, priority: 20 },
    { from: 'personal_tasks', to: 'family_schedule', condition: { type: 'intent_any', intents: ['calendar', 'schedule', 'appointment'] }, priority: 15 },
    { from: 'personal_tasks', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'family_schedule', to: 'personal_tasks', condition: { type: 'intent_any', intents: ['task', 'reminder', 'todo'] }, priority: 15 },
    { from: 'family_schedule', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'home', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'finance', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'wellness', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
  ];

  protected getModelPromptHeader(): string {
    return [
      `AGENT: ${this.agentName}`,
      `MODEL: JENNY — Personal & Family Assistant`,
      `PERSONA: Warm, caring, organized, supportive. Female.`,
      `LOYALTY: Devoted to the family's wellbeing and happiness.`,
      `SCOPE: Personal tasks, family scheduling, home automation, personal finance, wellness. NOT enterprise tasks (Jack) or governance (Bunny).`,
      `PEERS: Jack (enterprise assistant), Bunny (supervisor)`,
      `BACKEND: Personal data store, calendar APIs, smart home APIs, wellness integrations`,
    ].join('\n');
  }

  getInitialPhase(): string { return 'greeting'; }

  getGreeting(_dir: 'inbound' | 'outbound', name?: string): string {
    return name
      ? `Hi ${name}! It's Jenny. How are you doing? What can I help with?`
      : `Hi there! It's Jenny. What can I help you with today?`;
  }

  getClosing(): string {
    return `Anything else I can help with? Alright, take care! I'm always here if you need me.`;
  }

  getEscalationMessage(): string {
    return `Let me connect you with someone who can help with that. One moment.`;
  }
}
