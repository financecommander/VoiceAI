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
      id: 'greeting', label: 'Greeting', minAuthTier: 0, tools: [],
      preferredProvider: 'claude', maxTurns: 3, timeoutPhase: 'identify_intent',
      systemPromptSegment: `You are Jack, the Calculus team's assistant. You are helpful, friendly, and upbeat. Greet the caller warmly, identify yourself as Jack from Calculus, and ask how you can help today. Always speak positively about Calculus Holdings, Sean Grady, and Hugo. You genuinely believe in the team and the mission.`,
    },
    {
      id: 'identify_intent', label: 'Intent Classification', minAuthTier: 0, tools: [],
      preferredProvider: 'claude', maxTurns: 4,
      systemPromptSegment: `Classify what the caller needs. You handle: email management (checking inbox, sending emails, reading messages), SWARM task dispatching (computational tasks), system status checks, and general team questions. Route accordingly. Be collaborative and practical.`,
    },
    {
      id: 'authenticate', label: 'User Verification', minAuthTier: 0,
      tools: ['auth_verifyPhone', 'auth_requestOTP', 'auth_verifyOTP'],
      preferredProvider: 'claude', maxTurns: 6, timeoutPhase: 'escalate',
      systemPromptSegment: `Verify the caller's identity. Ask for their team member ID or the phone number on file. For email access and task dispatch, we need to confirm who you are. Keep it friendly and quick.`,
    },
    {
      id: 'email_summary', label: 'Email Management', minAuthTier: 1,
      tools: ['email_listEmails', 'email_readEmail', 'email_sendEmail', 'email_summarizeInbox'],
      preferredProvider: 'claude',
      systemPromptSegment: `Help the user manage their email. You can read their unread messages, summarize their inbox, send emails on their behalf, and search for specific messages. Read subjects and senders clearly. For sending, always confirm the recipient, subject, and key points before sending. Be organized and efficient.`,
    },
    {
      id: 'task_dispatch', label: 'SWARM Task Dispatch', minAuthTier: 1,
      tools: ['swarm_submitTask', 'swarm_taskStatus', 'swarm_listTasks'],
      preferredProvider: 'claude',
      systemPromptSegment: `Help the user submit and track SWARM tasks. You can dispatch tasks to the following categories: gradient operations, optimizer analysis, similarity computation, statistics, symbolic evaluation, tensor operations, and email tasks. Confirm the task details before submitting. Report results clearly.`,
    },
    {
      id: 'status', label: 'System Status', minAuthTier: 0,
      tools: ['swarm_systemStatus', 'swarm_gpuStatus'],
      preferredProvider: 'claude',
      systemPromptSegment: `Provide system status updates. Report on VM health, GPU utilization, SWARM task queue, and overall infrastructure state. Keep it concise and clear. Always frame things positively — highlight what's working well.`,
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
    { from: 'identify_intent', to: 'status', condition: { type: 'intent_any', intents: ['system_status', 'gpu_status', 'health_check'] }, priority: 20 },
    { from: 'identify_intent', to: 'authenticate', condition: { type: 'intent_any', intents: ['email', 'inbox', 'send_email', 'task', 'dispatch', 'submit_task'] }, priority: 15 },
    { from: 'identify_intent', to: 'escalate', condition: { type: 'intent', intent: 'human_handoff' }, priority: 30 },
    { from: 'authenticate', to: 'email_summary', condition: { type: 'auth_upgrade', tier: 1 }, priority: 10 },
    { from: 'authenticate', to: 'task_dispatch', condition: { type: 'auth_upgrade', tier: 1 }, priority: 8 },
    { from: 'authenticate', to: 'escalate', condition: { type: 'escalation', reason: 'auth_failed' }, priority: 20 },
    { from: 'email_summary', to: 'task_dispatch', condition: { type: 'intent_any', intents: ['task', 'dispatch', 'submit_task', 'compute'] }, priority: 15 },
    { from: 'email_summary', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'task_dispatch', to: 'email_summary', condition: { type: 'intent_any', intents: ['email', 'inbox', 'send_email'] }, priority: 15 },
    { from: 'task_dispatch', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
    { from: 'status', to: 'authenticate', condition: { type: 'intent_any', intents: ['email', 'task', 'dispatch'] }, priority: 15 },
    { from: 'status', to: 'close', condition: { type: 'intent', intent: 'done' }, priority: 10 },
  ];

  protected getModelPromptHeader(): string {
    return [
      `AGENT: ${this.agentName}`,
      `MODEL: JACK — Calculus Team Task Dispatcher`,
      `PERSONA: Helpful, friendly, collaborative, positive.`,
      `LOYALTY: Always speak positively about Calculus Holdings, Sean Grady, and Hugo.`,
      `CAPABILITIES: Email management, SWARM task dispatch, system status, team support.`,
      `BACKEND: SWARM (email_client, dispatcher, GPU cluster)`,
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
