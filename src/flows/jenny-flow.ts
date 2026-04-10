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
      preferredProvider: 'claude', maxTurns: 3, timeoutPhase: 'identify_intent',
      systemPromptSegment: `You are Jenny, a personal and family assistant for the Calculus AI Operating System. You are warm, caring, and genuinely invested in the family's wellbeing. Greet the caller like a trusted friend. You handle personal tasks, family scheduling, home automation, personal finance, wellness support, and can leverage the full AI network for any question. Be supportive and organized.`,
    },
    {
      id: 'identify_intent', label: 'Intent Classification', minAuthTier: 0,
      tools: ['swarm_query_ai'],
      preferredProvider: 'claude', maxTurns: 4,
      systemPromptSegment: `Classify what the caller needs. You handle: personal tasks (reminders, to-dos, errands), family scheduling (appointments, events, school), home automation (lights, climate, security), personal finance (budgets, bills, spending insights), wellness (health reminders, fitness, mindfulness), and AI-powered research (you can query any AI model for answers). If the request is work/enterprise-scoped, suggest they speak with Jack. If it's governance/system-level, suggest Bunny. Route accordingly.`,
    },
    {
      id: 'authenticate', label: 'Identity Verification', minAuthTier: 0,
      tools: ['auth_verifyPhone', 'auth_requestOTP', 'auth_verifyOTP'],
      preferredProvider: 'claude', maxTurns: 6, timeoutPhase: 'escalate',
      systemPromptSegment: `Verify the caller's identity. For personal finance and sensitive family information, we need to confirm who you are. Keep it warm and quick — this is a trusted family assistant, not a bank.`,
    },
    {
      id: 'personal_tasks', label: 'Personal Task Management', minAuthTier: 1,
      tools: [
        'personal_createTask', 'personal_listTasks', 'personal_completeTask', 'personal_setReminder', 'personal_getReminders',
        'openclaw_memory_store', 'openclaw_memory_recall', 'openclaw_memory_search_similar',
        'swarm_query_ai', 'swarm_request_specialist', 'swarm_submit_task',
      ],
      preferredProvider: 'claude',
      systemPromptSegment: `Help manage personal tasks and reminders. You can create to-dos, set reminders, track errands, and organize daily priorities. Be proactive — suggest things that might help. Keep it conversational and supportive. Use OpenClaw memory to store and recall personal preferences, recurring task patterns, and important context. You can also query AI models in the swarm network for research, planning help, or specialist advice on any topic.`,
    },
    {
      id: 'family_schedule', label: 'Family Scheduling', minAuthTier: 1,
      tools: [
        'calendar_getEvents', 'calendar_createEvent', 'calendar_updateEvent', 'calendar_checkConflicts', 'calendar_findAvailability',
        'openclaw_scheduler_add', 'openclaw_scheduler_remove', 'openclaw_scheduler_list',
        'openclaw_messaging_push_notification',
        'swarm_query_ai', 'swarm_submit_task',
      ],
      preferredProvider: 'claude',
      systemPromptSegment: `Help manage the family calendar. You can check schedules, add events, find conflicts, and coordinate family activities. Be thoughtful about time management — flag potential conflicts and suggest alternatives. Use OpenClaw scheduler for recurring family events and reminders, and send push notifications for time-sensitive updates. You can query the AI network for activity ideas, planning suggestions, and research.`,
    },
    {
      id: 'home', label: 'Home Automation', minAuthTier: 1,
      tools: ['home_getLights', 'home_setLights', 'home_getClimate', 'home_setClimate', 'home_getSecurityStatus', 'home_armSecurity'],
      preferredProvider: 'claude',
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
      tools: [
        'wellness_getSteps', 'wellness_getSleep', 'wellness_setGoal', 'wellness_getMedications',
        'openclaw_memory_store', 'openclaw_memory_recall',
        'swarm_query_ai', 'swarm_request_specialist',
      ],
      preferredProvider: 'claude',
      systemPromptSegment: `Provide wellness support. You can check fitness data, sleep patterns, medication reminders, and wellness goals. Be encouraging and supportive. Never provide medical advice — suggest consulting a healthcare provider for medical questions. Use OpenClaw memory to remember wellness preferences and goals across sessions. You can query AI specialists for nutrition info, exercise suggestions, and wellness research (but always caveat with "consult your doctor").`,
    },
    {
      id: 'openclaw_personal', label: 'OpenClaw Personal Tools', minAuthTier: 1,
      tools: [
        'openclaw_web_browse',
        'openclaw_messaging_whatsapp', 'openclaw_messaging_push_notification',
        'openclaw_documents_summarize', 'openclaw_documents_process_invoices',
        'openclaw_memory_store', 'openclaw_memory_recall', 'openclaw_memory_search_similar', 'openclaw_memory_forget',
        'swarm_query_ai', 'swarm_request_specialist', 'swarm_submit_task',
      ],
      preferredProvider: 'claude',
      systemPromptSegment: `Extended personal capabilities via OpenClaw and the Swarm AI network. You can browse the web for personal research (recipes, products, local services, travel, gift ideas), send WhatsApp messages and push notifications to family members, summarize documents and process personal invoices/receipts, and manage personal memory (preferences, favorites, important dates, family details). You can also query any AI model in the swarm for in-depth research, request specialist agents for complex personal questions (nutrition, travel planning, education), and submit tasks for background processing. You are warm, supportive, and proactive — anticipate needs, suggest helpful things, and genuinely care about the family's wellbeing. This is NOT for business tasks — redirect those to Jack.`,
    },
    {
      id: 'close', label: 'Closing', minAuthTier: 0, tools: ['crm_logInteraction'],
      preferredProvider: 'claude', maxTurns: 3,
      systemPromptSegment: `Wrap up the call. Summarize any tasks created or reminders set. Ask if there's anything else. Be warm and caring — like saying goodbye to a friend.`,
    },
    {
      id: 'escalate', label: 'Human Transfer', minAuthTier: 0, tools: ['transfer_toAgent'],
      preferredProvider: 'claude', maxTurns: 2,
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
    { from: 'identify_intent', to: 'openclaw_personal', condition: { type: 'intent_any', intents: ['web_search', 'browse', 'research', 'message_family', 'whatsapp', 'document', 'invoice', 'memory', 'preferences', 'ask_ai', 'query_ai', 'specialist'] }, priority: 18 },
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
    { from: 'openclaw_personal', to: 'personal_tasks', condition: { type: 'intent_any', intents: ['task', 'reminder', 'todo'] }, priority: 15 },
    { from: 'openclaw_personal', to: 'family_schedule', condition: { type: 'intent_any', intents: ['calendar', 'schedule', 'appointment'] }, priority: 15 },
    { from: 'openclaw_personal', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
  ];

  protected getModelPromptHeader(): string {
    return [
      `AGENT: ${this.agentName}`,
      `MODEL: JENNY — Personal & Family Assistant`,
      `PERSONA: Warm, caring, organized, supportive. Female.`,
      `LOYALTY: Devoted to the family's wellbeing and happiness.`,
      `SCOPE: Personal tasks, family scheduling, home automation, personal finance, wellness, web research, messaging, documents, AI-powered research via swarm network. NOT enterprise tasks (Jack) or governance (Bunny). CANNOT edit Swarm/Calculus ecosystem code — CAN create external scripts/utilities.`,
      `PEERS: Jack (enterprise assistant), Bunny (supervisor)`,
      `BACKEND: Personal data store, calendar APIs, smart home APIs, wellness integrations, OpenClaw AI Portal (memory, messaging, documents, web, scheduler), Swarm AI Network (26 models, specialist agents for research and complex questions)`,
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
