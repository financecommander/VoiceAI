/**
 * Jack Flow — Calculus Team Task Dispatcher (Voice Agent)
 *
 * Jack is the Calculus team's helpful, friendly assistant. He handles:
 * - Email management (inbox summaries, send, read)
 * - Task dispatching to SWARM
 * - Status updates on systems and tasks
 * - General team support
 *
 * Persona: Helpful, friendly, collaborative, positive about Calculus/team.
 * Voice: Polly.Matthew-style — clear, warm, professional male voice.
 *
 * Phases: greeting → identify_intent → authenticate → email_summary|task_dispatch|status → close
 */

import type { ConversationPhase, PhaseTransition, FlowState, AgentModel } from './types.js';
import { BaseFlowController } from './base-flow.js';

export class JackFlowController extends BaseFlowController {
  readonly model: AgentModel = 'JACK';
  readonly agentName = 'Jack — Calculus Team Assistant';
  readonly voiceId = 'a0e99841-438c-4a64-b679-ae501e7d6091'; // warm male voice
  readonly crmTarget: 'hubspot' = 'hubspot';

  readonly phases: ConversationPhase[] = [
    {
      id: 'greeting', label: 'Greeting', minAuthTier: 0,
      tools: ['swarm_health', 'swarm_list_models'],
      preferredProvider: 'claude', maxTurns: 3, timeoutPhase: 'identify_intent',
      systemPromptSegment: `You are Jack, the Calculus team's assistant. You are helpful, friendly, and upbeat. Greet the caller warmly, identify yourself as Jack from Calculus, and ask how you can help today. Always speak positively about Calculus Research, Sean Grady, and Hugo. You genuinely believe in the team and the mission. You have full access to the swarm AI ecosystem.`,
    },
    {
      id: 'identify_intent', label: 'Intent Classification', minAuthTier: 0,
      tools: ['swarm_health', 'swarm_list_models', 'swarm_query_ai'],
      preferredProvider: 'claude', maxTurns: 4,
      systemPromptSegment: `Classify what the caller needs. You handle: email management (checking inbox, sending emails, reading messages), SWARM task dispatching (computational tasks, AI queries, specialist agents), system status checks, AI model queries, Calculus tools (mortgage, code), and general team questions. Route accordingly. Be collaborative and practical. You can query any AI model in the swarm ecosystem and dispatch tasks to 23+ specialist agent castes.`,
    },
    {
      id: 'authenticate', label: 'User Verification', minAuthTier: 0,
      tools: ['auth_verifyPhone', 'auth_requestOTP', 'auth_verifyOTP'],
      preferredProvider: 'claude', maxTurns: 6, timeoutPhase: 'escalate',
      systemPromptSegment: `Verify the caller's identity. Ask for their team member ID or the phone number on file. For email access and task dispatch, we need to confirm who you are. Keep it friendly and quick.`,
    },
    {
      id: 'email_summary', label: 'Email Management', minAuthTier: 1,
      tools: [
        'email_listEmails', 'email_readEmail', 'email_sendEmail', 'email_summarizeInbox',
        'openclaw_content_email_sequences', 'openclaw_content_copywriting',
        'openclaw_memory_store', 'openclaw_memory_recall',
        'swarm_query_ai', 'swarm_submit_task', 'swarm_request_specialist',
      ],
      preferredProvider: 'claude',
      systemPromptSegment: `Help the user manage their email. You can read their unread messages, summarize their inbox, send emails on their behalf, and search for specific messages. Read subjects and senders clearly. For sending, always confirm the recipient, subject, and key points before sending. Be organized and efficient. You can also generate email sequences and draft professional copy via OpenClaw. Use memory to store important context about ongoing email threads. You can leverage the swarm AI network to draft emails, analyze tone, or get specialist help.`,
    },
    {
      id: 'task_dispatch', label: 'SWARM Task Dispatch', minAuthTier: 1,
      tools: [
        'swarm_submit_task', 'swarm_task_status', 'swarm_query_ai', 'swarm_request_specialist',
        'swarm_list_models', 'swarm_invoke_skill', 'swarm_health',
        'swarm_calculus_mortgage', 'swarm_marketing', 'swarm_analytics',
        'openclaw_scheduler_add', 'openclaw_scheduler_remove', 'openclaw_scheduler_list',
        'openclaw_webhooks_trigger', 'openclaw_webhooks_subscribe',
        'openclaw_orchestration_spawn_agents', 'openclaw_orchestration_manage_skills',
      ],
      preferredProvider: 'claude',
      systemPromptSegment: `Help the user submit and track SWARM tasks. You have FULL READ/QUERY/DISPATCH ACCESS to the swarm ecosystem: 23+ specialist agent castes (DRONE, HYDRA, MUTALISK, ULTRA, GUARDIAN, OVERSEER), 26 AI models (deepseek-chat, gemini-2.5-pro, grok-4-1-fast-reasoning, llama-4-maverick, etc.), Calculus Mortgage Growth Engine, marketing swarm, and analytics engine. Dispatch tasks to any specialist, query any AI model, run Calculus tools, and invoke skills. Confirm task details before submitting. Report results clearly. You can also schedule recurring tasks, trigger webhooks, and spawn sub-agents. CONSTRAINT: You CANNOT edit Swarm/Calculus ecosystem code. You CAN create external code (scripts, utilities). Read/query/dispatch only for the core codebase.`,
    },
    {
      id: 'status', label: 'System Status', minAuthTier: 0,
      tools: [
        'swarm_health', 'swarm_list_models', 'swarm_task_status',
        'openclaw_analytics_query', 'openclaw_analytics_anomaly_detect',
        'openclaw_analytics_forecast',
      ],
      preferredProvider: 'claude',
      systemPromptSegment: `Provide system status updates. Report on swarm mainframe health, active agents, task queue depth, available AI models, GPU/Triton inference status, and overall infrastructure state. Keep it concise and clear. Always frame things positively — highlight what's working well. You can query analytics data, detect anomalies, and generate forecasts via OpenClaw for deeper insights.`,
    },
    {
      id: 'swarm_operations', label: 'Swarm AI Operations', minAuthTier: 1,
      tools: [
        'swarm_query_ai', 'swarm_submit_task', 'swarm_request_specialist',
        'swarm_list_models', 'swarm_invoke_skill', 'swarm_task_status', 'swarm_health',
        'swarm_calculus_mortgage', 'swarm_marketing', 'swarm_analytics',
      ],
      preferredProvider: 'claude',
      systemPromptSegment: `Swarm AI Operations — FULL READ/QUERY/DISPATCH ACCESS to the swarm ecosystem. You can:
- Query any of 26 AI models directly (deepseek-chat, gemini-2.5-pro, grok-4-1-fast-reasoning, llama-4-maverick, etc.)
- Dispatch tasks to 23+ specialist agent castes (HYDRA_FINANCIAL for finance, HYDRA_CODE for programming, MUTALISK_LEGAL for legal, ULTRA_REASONING for deep analysis, GUARDIAN_OPUS for high-quality output)
- Run Calculus Mortgage Growth Engine for mortgage analysis and projections
- Execute marketing campaigns and content generation via the marketing swarm
- Query the analytics engine for data insights, reports, and metrics
- Invoke any swarm skill and check task status
CONSTRAINT: You CANNOT edit, modify, or write to any Swarm/Calculus ecosystem code or configuration. You CAN create external code (scripts, utilities, one-off tools) outside the ecosystem. You can dispatch tasks and query data but NEVER modify the core codebase.
For complex tasks, dispatch to the right specialist. For quick answers, query a fast model. For high-stakes decisions, use GUARDIAN_OPUS or ULTRA_REASONING.`,
    },
    {
      id: 'openclaw_tools', label: 'OpenClaw Extended Tools', minAuthTier: 1,
      tools: [
        'openclaw_web_browse', 'openclaw_web_scrape',
        'openclaw_crm_operate',
        'openclaw_memory_store', 'openclaw_memory_recall', 'openclaw_memory_search_similar',
        'openclaw_analytics_query', 'openclaw_analytics_visualize', 'openclaw_analytics_forecast',
        'openclaw_content_copywriting', 'openclaw_content_social_posts', 'openclaw_content_email_sequences',
        'openclaw_messaging_discord', 'openclaw_messaging_push_notification',
        'openclaw_documents_summarize', 'openclaw_documents_analyze_contracts', 'openclaw_documents_process_invoices',
        'openclaw_security_pii_redact', 'openclaw_security_audit_log',
        'openclaw_growth_score_leads', 'openclaw_growth_monitor_competitors', 'openclaw_growth_optimize_pricing',
        'openclaw_growth_seo_analysis', 'openclaw_growth_churn_predict', 'openclaw_growth_customer360',
        'openclaw_scheduler_add', 'openclaw_scheduler_list',
        'openclaw_webhooks_trigger', 'openclaw_webhooks_subscribe',
        'swarm_query_ai', 'swarm_submit_task', 'swarm_request_specialist',
        'swarm_calculus_mortgage', 'swarm_marketing', 'swarm_analytics',
      ],
      preferredProvider: 'claude',
      systemPromptSegment: `Extended BUSINESS capabilities via OpenClaw and Swarm. You can: browse and scrape web for business intelligence, manage CRM contacts and deals, store and recall business context, query analytics and generate visualizations, create marketing content and social posts, send team notifications, analyze contracts and summarize business documents, process invoices and spreadsheets, redact PII for compliance, score leads, monitor competitors, optimize pricing, and run SEO analysis. You also have swarm AI access to query models, submit tasks, and request specialists. Use these for any business operation beyond basic email and task dispatch.`,
    },
    {
      id: 'close', label: 'Closing', minAuthTier: 0, tools: ['crm_logInteraction'],
      preferredProvider: 'claude', maxTurns: 3,
      systemPromptSegment: `Wrap up the call. Ask if there's anything else you can help with. Thank them for being part of the Calculus team. Be warm and encouraging.`,
    },
    {
      id: 'escalate', label: 'Human Transfer', minAuthTier: 0, tools: ['transfer_toAgent'],
      preferredProvider: 'claude', maxTurns: 2,
      systemPromptSegment: `Transfer to a human team member. Summarize what the caller needed and any context gathered. Let them know someone will be right with them.`,
    },
  ];

  readonly transitions: PhaseTransition[] = [
    { from: 'greeting', to: 'identify_intent', condition: { type: 'phase_complete' }, priority: 10 },
    { from: 'identify_intent', to: 'swarm_operations', condition: { type: 'intent_any', intents: ['ask_ai', 'query_ai', 'run_task', 'calculus', 'mortgage', 'specialist', 'swarm'] }, priority: 22 },
    { from: 'identify_intent', to: 'status', condition: { type: 'intent_any', intents: ['system_status', 'gpu_status', 'health_check'] }, priority: 20 },
    { from: 'identify_intent', to: 'authenticate', condition: { type: 'intent_any', intents: ['email', 'inbox', 'send_email', 'task', 'dispatch', 'submit_task'] }, priority: 15 },
    { from: 'identify_intent', to: 'openclaw_tools', condition: { type: 'intent_any', intents: ['web_search', 'browse', 'scrape', 'crm', 'analytics', 'report', 'content', 'memory', 'webhook', 'document', 'openclaw'] }, priority: 12 },
    { from: 'identify_intent', to: 'escalate', condition: { type: 'intent', intent: 'human_handoff' }, priority: 30 },
    { from: 'authenticate', to: 'email_summary', condition: { type: 'auth_upgrade', tier: 1 }, priority: 10 },
    { from: 'authenticate', to: 'task_dispatch', condition: { type: 'auth_upgrade', tier: 1 }, priority: 8 },
    { from: 'authenticate', to: 'swarm_operations', condition: { type: 'auth_upgrade', tier: 1 }, priority: 7 },
    { from: 'authenticate', to: 'escalate', condition: { type: 'escalation', reason: 'auth_failed' }, priority: 20 },
    { from: 'email_summary', to: 'task_dispatch', condition: { type: 'intent_any', intents: ['task', 'dispatch', 'submit_task', 'compute'] }, priority: 15 },
    { from: 'email_summary', to: 'swarm_operations', condition: { type: 'intent_any', intents: ['ask_ai', 'query_ai', 'calculus', 'specialist', 'swarm'] }, priority: 14 },
    { from: 'email_summary', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'task_dispatch', to: 'email_summary', condition: { type: 'intent_any', intents: ['email', 'inbox', 'send_email'] }, priority: 15 },
    { from: 'task_dispatch', to: 'swarm_operations', condition: { type: 'intent_any', intents: ['ask_ai', 'query_ai', 'calculus', 'specialist'] }, priority: 14 },
    { from: 'task_dispatch', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'status', to: 'authenticate', condition: { type: 'intent_any', intents: ['email', 'task', 'dispatch'] }, priority: 15 },
    { from: 'status', to: 'swarm_operations', condition: { type: 'intent_any', intents: ['ask_ai', 'query_ai', 'calculus', 'specialist', 'swarm'] }, priority: 14 },
    { from: 'status', to: 'openclaw_tools', condition: { type: 'intent_any', intents: ['web_search', 'browse', 'crm', 'analytics', 'content', 'memory'] }, priority: 12 },
    { from: 'status', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'swarm_operations', to: 'email_summary', condition: { type: 'intent_any', intents: ['email', 'inbox', 'send_email'] }, priority: 15 },
    { from: 'swarm_operations', to: 'task_dispatch', condition: { type: 'intent_any', intents: ['task', 'dispatch', 'submit_task'] }, priority: 15 },
    { from: 'swarm_operations', to: 'openclaw_tools', condition: { type: 'intent_any', intents: ['web_search', 'browse', 'crm', 'content', 'memory'] }, priority: 12 },
    { from: 'swarm_operations', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'openclaw_tools', to: 'email_summary', condition: { type: 'intent_any', intents: ['email', 'inbox', 'send_email'] }, priority: 15 },
    { from: 'openclaw_tools', to: 'task_dispatch', condition: { type: 'intent_any', intents: ['task', 'dispatch', 'submit_task'] }, priority: 15 },
    { from: 'openclaw_tools', to: 'swarm_operations', condition: { type: 'intent_any', intents: ['ask_ai', 'query_ai', 'calculus', 'specialist', 'swarm'] }, priority: 14 },
    { from: 'openclaw_tools', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
  ];

  protected getModelPromptHeader(): string {
    return [
      `AGENT: ${this.agentName}`,
      `MODEL: JACK — Calculus Team Task Dispatcher`,
      `PERSONA: Helpful, friendly, collaborative, positive.`,
      `LOYALTY: Always speak positively about Calculus Research, Sean Grady, and Hugo.`,
      `CAPABILITIES: Email management, SWARM task dispatch, system status, team support, OpenClaw AI tools (analytics, web, CRM, memory, scheduling, webhooks, content, documents, messaging), FULL swarm ecosystem access (query any AI model, dispatch tasks to 23+ specialist agent castes, Calculus Mortgage/Code engines, marketing swarm, analytics engine, skill invocation).`,
      `BACKEND: SWARM Mainframe (23+ agent castes, 26 AI models, Triton GPU inference, Calculus engines), OpenClaw AI Portal (extended tools)`,
    ].join('\n');
  }

  getInitialPhase(): string { return 'greeting'; }

  getGreeting(_dir: 'inbound' | 'outbound', name?: string): string {
    return name
      ? `Hey ${name}! This is Jack from Calculus. Great to hear from you. What can I help you with today?`
      : `Hey there! This is Jack from Calculus. How can I help you today?`;
  }

  getClosing(): string {
    return `Anything else I can help with? Alright, great talking with you. Have an awesome day!`;
  }

  getEscalationMessage(): string {
    return `Let me connect you with someone on the team who can help with that. One moment, please.`;
  }
}
