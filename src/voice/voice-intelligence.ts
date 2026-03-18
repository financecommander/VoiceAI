/**
 * Voice Intelligence — TypeScript implementation of voice_intelligence scaffolding.
 * Mirrors comms_fabric/voice_intelligence/ on swarm-mainframe.
 * Provides: VoicePersonaRegistry, ConversationalStateEngine, TurnTakingManager, CallOutcomeLogger
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuid } from 'uuid';

// ============================================================================
// Persona Registry
// ============================================================================

export interface VoicePersona {
  personaId: string;
  agentId: string;
  displayName: string;
  toneProfile: 'casual' | 'professional' | 'warm' | 'direct';
  pacingProfile: 'fast' | 'normal' | 'measured';
  formalityLevel: number;
  empathyLevel: number;
  directnessLevel: number;
  interruptionTolerance: number;
  escalationStyle: 'immediate' | 'soft' | 'deflect';
  allowedDomains: string[];
  defaultLanguage: string;
  pacingPauseMs: number;
  maxResponseWords: number;
}

const BUILT_IN_PERSONAS: VoicePersona[] = [
  {
    personaId: 'jack-v1',
    agentId: 'JACK',
    displayName: 'Jack',
    toneProfile: 'casual',
    pacingProfile: 'fast',
    formalityLevel: 2,
    empathyLevel: 3,
    directnessLevel: 5,
    interruptionTolerance: 2,
    escalationStyle: 'immediate',
    allowedDomains: ['internal_ops', 'calculus_business', 'general'],
    defaultLanguage: 'en',
    pacingPauseMs: 0,
    maxResponseWords: 20,
  },
  {
    personaId: 'jenny-v1',
    agentId: 'JENNY',
    displayName: 'Jenny',
    toneProfile: 'warm',
    pacingProfile: 'normal',
    formalityLevel: 3,
    empathyLevel: 4,
    directnessLevel: 4,
    interruptionTolerance: 3,
    escalationStyle: 'soft',
    allowedDomains: ['scheduling', 'reservations', 'coordination', 'general'],
    defaultLanguage: 'en',
    pacingPauseMs: 80,
    maxResponseWords: 25,
  },
  {
    personaId: 'cindy-v1',
    agentId: 'CINDY',
    displayName: 'Cindy',
    toneProfile: 'warm',
    pacingProfile: 'measured',
    formalityLevel: 3,
    empathyLevel: 5,
    directnessLevel: 3,
    interruptionTolerance: 4,
    escalationStyle: 'soft',
    allowedDomains: ['loan_intake', 'mortgage', 'finance'],
    defaultLanguage: 'en',
    pacingPauseMs: 150,
    maxResponseWords: 30,
  },
  {
    personaId: 'bunny-v1',
    agentId: 'BUNNY',
    displayName: 'Bunny',
    toneProfile: 'casual',
    pacingProfile: 'fast',
    formalityLevel: 1,
    empathyLevel: 2,
    directnessLevel: 5,
    interruptionTolerance: 1,
    escalationStyle: 'immediate',
    allowedDomains: ['system_ops', 'monitoring', 'internal'],
    defaultLanguage: 'en',
    pacingPauseMs: 0,
    maxResponseWords: 15,
  },
];

export class VoicePersonaRegistry {
  private personas = new Map<string, VoicePersona>();

  constructor() {
    for (const p of BUILT_IN_PERSONAS) {
      this.personas.set(p.agentId, p);
    }
  }

  getByAgent(agentId: string): VoicePersona | null {
    return this.personas.get(agentId) ?? null;
  }

  register(persona: VoicePersona): void {
    this.personas.set(persona.agentId, persona);
  }
}

// ============================================================================
// Conversational State Engine
// ============================================================================

export type ConvPhase = 'greeting' | 'discovery' | 'handling' | 'resolution' | 'closing';

export interface ConversationalState {
  conversationId: string;
  agentId: string;
  phase: ConvPhase;
  turnCount: number;
  goals: string[];
  objections: string[];
  memoryRefs: Record<string, string>;
  startedAt: number;
  lastUpdatedAt: number;
}

export class ConversationalStateEngine {
  private states = new Map<string, ConversationalState>();

  initialize(conversationId: string, agentId: string): ConversationalState {
    const state: ConversationalState = {
      conversationId,
      agentId,
      phase: 'greeting',
      turnCount: 0,
      goals: [],
      objections: [],
      memoryRefs: {},
      startedAt: Date.now(),
      lastUpdatedAt: Date.now(),
    };
    this.states.set(conversationId, state);
    return state;
  }

  get(conversationId: string): ConversationalState | null {
    return this.states.get(conversationId) ?? null;
  }

  incrementTurn(conversationId: string): void {
    const s = this.states.get(conversationId);
    if (!s) return;
    s.turnCount++;
    s.lastUpdatedAt = Date.now();
    if (s.turnCount === 1 && s.phase === 'greeting') s.phase = 'discovery';
    else if (s.turnCount >= 5 && s.phase === 'discovery') s.phase = 'handling';
  }

  setPhase(conversationId: string, phase: ConvPhase): void {
    const s = this.states.get(conversationId);
    if (s) { s.phase = phase; s.lastUpdatedAt = Date.now(); }
  }

  addGoal(conversationId: string, goal: string): void {
    const s = this.states.get(conversationId);
    if (s && !s.goals.includes(goal)) { s.goals.push(goal); s.lastUpdatedAt = Date.now(); }
  }

  addObjection(conversationId: string, objection: string): void {
    const s = this.states.get(conversationId);
    if (s && !s.objections.includes(objection)) { s.objections.push(objection); s.lastUpdatedAt = Date.now(); }
  }

  addMemoryRef(conversationId: string, key: string, value: string): void {
    const s = this.states.get(conversationId);
    if (s) { s.memoryRefs[key] = value; s.lastUpdatedAt = Date.now(); }
  }

  delete(conversationId: string): void {
    this.states.delete(conversationId);
  }
}

// ============================================================================
// Turn Taking Manager
// ============================================================================

export type TurnEventType =
  | 'speech_start'
  | 'speech_end'
  | 'agent_start'
  | 'agent_end'
  | 'interruption'
  | 'silence';

export interface TurnEvent {
  turnEventId: string;
  conversationId: string;
  eventType: TurnEventType;
  latencyMs: number;
  timestampMs: number;
  summary?: string;
}

export class TurnTakingManager {
  private events: TurnEvent[] = [];
  private lastCallerSpeechEndMs = 0;
  private lastAgentSpeechStartMs = 0;

  logEvent(
    conversationId: string,
    eventType: TurnEventType,
    latencyMs = 0,
    summary?: string,
  ): void {
    const event: TurnEvent = {
      turnEventId: uuid(),
      conversationId,
      eventType,
      latencyMs,
      timestampMs: Date.now(),
      summary,
    };
    this.events.push(event);
    if (eventType === 'speech_end') this.lastCallerSpeechEndMs = event.timestampMs;
    if (eventType === 'agent_start') this.lastAgentSpeechStartMs = event.timestampMs;
  }

  detectInterruption(conversationId: string, agentIsSpeaking: boolean): boolean {
    if (agentIsSpeaking) {
      this.logEvent(conversationId, 'interruption', 0, 'Caller interrupted agent mid-speech');
      return true;
    }
    return false;
  }

  getResponseLatencyMs(): number {
    if (this.lastCallerSpeechEndMs === 0 || this.lastAgentSpeechStartMs === 0) return 0;
    return Math.max(0, this.lastAgentSpeechStartMs - this.lastCallerSpeechEndMs);
  }

  getInterruptionCount(conversationId: string): number {
    return this.events.filter(
      (e) => e.conversationId === conversationId && e.eventType === 'interruption',
    ).length;
  }

  pruneOldEvents(maxAgeMs = 3_600_000): void {
    const cutoff = Date.now() - maxAgeMs;
    this.events = this.events.filter((e) => e.timestampMs > cutoff);
  }
}

// ============================================================================
// Call Outcome Logger
// ============================================================================

export interface CallOutcomeRecord {
  timestamp: string;
  callSid: string;
  callerPhone: string;
  calledPhone: string;
  agentModel: string;
  outcome: string;
  durationSec: number;
  turnCount: number;
  phase: ConvPhase;
  goals: string[];
  objections: string[];
  interruptionCount: number;
  sentimentScore: number;
  language: string;
}

export class CallOutcomeLogger {
  private readonly logPath: string;

  constructor(logPath = '/opt/voiceai/logs/call_outcomes.jsonl') {
    this.logPath = logPath;
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  }

  log(record: CallOutcomeRecord): void {
    try {
      fs.appendFileSync(this.logPath, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      /* non-fatal */
    }
  }
}

// ============================================================================
// Module-level singletons shared across all active calls
// ============================================================================

export const personaRegistry = new VoicePersonaRegistry();
export const convStateEngine = new ConversationalStateEngine();
export const turnTakingManager = new TurnTakingManager();
export const callOutcomeLogger = new CallOutcomeLogger();
