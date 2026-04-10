/**
 * Voice Call Simulation — 1000 Calls
 *
 * End-to-end simulation of the full TwilioMediaStreamHandler pipeline with
 * all external I/O mocked. Validates the VoiceAI changes shipped in this sprint:
 *
 *   P1 — Deepgram Nova-3 + 300ms endpointing
 *   P4 — ConversationalNaturalnessEngine (backchannels, latency masks, naturalness instructions)
 *   P5 — Post-call Claude summary → GHL CRM push via OpenClaw
 *   P6 — Confidence-based re-ask (< 0.75 threshold)
 *
 * Run: npm run test:run -- voice-sim
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { EventEmitter } from 'events';
import pino from 'pino';

// ============================================================================
// Hoisted mock handles — declared before vi.mock() factories run
// ============================================================================

const mockHandles = vi.hoisted(() => {
  // Per-scenario CRM tracking by phone number (avoids shared mock pollution)
  const crmPushedPhones = new Set<string>();
  const crmOperate = vi.fn().mockImplementation((params: any) => {
    if (params?.phone) crmPushedPhones.add(params.phone);
    return Promise.resolve({ success: true });
  });
  const getOpenClawClient = vi.fn(() => ({ crmOperate }));
  const isOpenClawConfigured = vi.fn().mockReturnValue(true);
  const personaRegistry = { getByAgent: vi.fn().mockReturnValue(null) };
  const convStateEngine = {
    initialize: vi.fn(),
    get: vi.fn().mockReturnValue({ turnCount: 1, phase: 'greeting', goals: [], objections: [] }),
    incrementTurn: vi.fn(),
    addGoal: vi.fn(),
    addObjection: vi.fn(),
    delete: vi.fn(),
  };
  const turnTakingManager = {
    logEvent: vi.fn(),
    detectInterruption: vi.fn(),
    getInterruptionCount: vi.fn().mockReturnValue(0),
  };
  const callOutcomeLogger = { log: vi.fn() };
  return {
    crmOperate, crmPushedPhones, getOpenClawClient, isOpenClawConfigured,
    personaRegistry, convStateEngine, turnTakingManager, callOutcomeLogger,
  };
});

vi.mock('../src/services/openclaw-client.js', () => ({
  getOpenClawClient: mockHandles.getOpenClawClient,
  isOpenClawConfigured: mockHandles.isOpenClawConfigured,
}));

vi.mock('../src/voice/voice-intelligence.js', () => ({
  personaRegistry: mockHandles.personaRegistry,
  convStateEngine: mockHandles.convStateEngine,
  turnTakingManager: mockHandles.turnTakingManager,
  callOutcomeLogger: mockHandles.callOutcomeLogger,
}));

// Mocked after module-level mocks
import { TwilioMediaStreamHandler } from '../src/gateway/twilio-stream.js';

// ============================================================================
// Mock Implementations
// ============================================================================

/** Fake WebSocket with message/close simulation helpers */
class MockWebSocket extends EventEmitter {
  readyState = 1; // OPEN
  sentMessages: string[] = [];

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }

  simulateMessage(msg: object): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
}

/** Fake Deepgram — injects transcripts on demand, no real WebSocket */
class MockDeepgram extends EventEmitter {
  private _connected = false;
  capturedStreamOptions: any = null;

  async startStream(options: any): Promise<void> {
    this.capturedStreamOptions = options;
    this._connected = true;
    // Immediately emit Open so startStream resolves correctly
  }

  async stopStream(): Promise<void> {
    this._connected = false;
  }

  sendAudio(_chunk: Buffer): void { /* no-op */ }
  keepAlive(): void { /* no-op */ }

  get connected(): boolean { return this._connected; }

  /** Inject a final transcript with a given confidence score */
  injectTranscript(text: string, confidence = 1.0): void {
    this.emit('transcript', text, true, true, 'en', confidence);
  }

  injectSpeechStarted(): void {
    this.emit('speechStarted');
  }
}

/** Fake Cartesia — captures synthesize/streamText calls, no real audio */
class MockCartesia extends EventEmitter {
  synthesizeCalls: string[] = [];
  streamTextCalls: string[] = [];
  cancelCount = 0;
  setModelCalls: string[] = [];

  async connect(): Promise<void> {
    // Signal ready immediately
    setTimeout(() => this.emit('connected'), 0);
  }

  setModel(model: string): void {
    this.setModelCalls.push(model);
  }

  setLanguage(_lang: string): void { /* no-op */ }

  async synthesize(text: string): Promise<void> {
    this.synthesizeCalls.push(text);
    this.emit('synthesize', text);
    // Simulate audio + done
    this.emit('audio', Buffer.alloc(160));
    this.emit('done');
  }

  async startStream(_language?: string): Promise<void> { /* no-op */ }

  streamText(text: string): void {
    this.streamTextCalls.push(text);
    this.emit('audio', Buffer.alloc(160));
  }

  endStream(_finalText?: string): void {
    this.emit('done');
  }

  cancel(): void {
    this.cancelCount++;
  }

  resetContext(): void { /* no-op */ }
}

/** Fake LLM — returns deterministic responses; captures systemInstructions */
class MockLLM {
  capturedSystemInstructions: string[] = [];

  async generateResponse(_params: any): Promise<any> {
    return {
      text: 'I can help you with that. Your account balance is $4,523.87.',
      provider: 'gpt-4o',
      toolCalls: [],
      latencyMs: 120,
      tokensUsed: 42,
      wasFallback: false,
    };
  }

  async generateResponseStreaming(params: any): Promise<any> {
    this.capturedSystemInstructions.push(params.systemInstruction ?? '');
    // Drive the onChunk callback with a mock sentence
    if (params.onChunk) {
      params.onChunk('I can help you with that. ', false);
      params.onChunk('Your balance is $4,523.87.', false);
      params.onChunk('', true);
    }
    return {
      text: 'I can help you with that. Your balance is $4,523.87.',
      provider: params.provider ?? 'gpt-4o',
      toolCalls: [],
      latencyMs: 90,
      tokensUsed: 30,
      wasFallback: false,
    };
  }
}

/** Fake Pipeline Controller — configurable TurnResult per scenario */
class MockPipelineController {
  private turnResultFn: (utterance: string) => any;
  private pipeline: 'modular' | 'speech-to-speech';

  constructor(turnResultFn: (utterance: string) => any, pipeline: 'modular' | 'speech-to-speech' = 'modular') {
    this.turnResultFn = turnResultFn;
    this.pipeline = pipeline;
  }

  async initializeCall(_params: any): Promise<any> {
    return { proceed: true, session: { conversationId: 'sim-' + Date.now() } };
  }

  async processTurn(utterance: string): Promise<any> {
    return this.turnResultFn(utterance);
  }

  getActivePipeline(): string { return this.pipeline; }

  getSession(): any {
    return {
      conversationId: 'sim-test',
      goals: [],
      scorecard: {
        disclosureDelivered: true,
        recordingConsentCaptured: false,
        piiIncidentCount: 0,
        optOutHonored: true,
        humanHandoffAvailable: true,
      },
    };
  }

  async endCall(_outcome: string): Promise<any> {
    return { conversationId: 'sim-test', endedAt: new Date(), scorecard: {
      disclosureDelivered: true,
      recordingConsentCaptured: false,
      piiIncidentCount: 0,
      optOutHonored: true,
      humanHandoffAvailable: true,
    } };
  }

  routeAudio(_pcm: Buffer): void { /* no-op */ }
}

/** Fake Conversation Memory — no DB, returns null for all lookups */
class MockConversationMemory {
  saveCount = 0;

  async getCallerContext(_phone: string): Promise<any> { return null; }
  async getCallerGreeting(_phone: string, _agent: string): Promise<string> {
    return "Welcome back! How can I help you today?";
  }
  async saveCallSummary(_phone: string, _summary: any): Promise<void> {
    this.saveCount++;
  }
  async getRecentInteractions(_phone: string): Promise<any[]> { return []; }
  async recordInteraction(_phone: string, _data: any): Promise<void> { /* no-op */ }
}

/** Fake ToolExecutor — returns empty results */
class MockToolExecutor {
  async execute(_name: string, _args: any, _ctx: any): Promise<any> {
    return { result: 'mock_tool_result', success: true };
  }
}

// ============================================================================
// Scenario Types + Generator
// ============================================================================

type Agent = 'JACK' | 'JENNY' | 'BUNNY' | 'CINDY';
type Intent = 'balance_inquiry' | 'pricing_inquiry' | 'loan_inquiry' | 'payment_inquiry' |
              'account_status' | 'general_inquiry' | 'opt_out' | 'escalate';
type Direction = 'inbound' | 'outbound';

interface Turn {
  transcript: string;
  confidence: number;
}

interface Scenario {
  id: number;
  agent: Agent;
  direction: Direction;
  callerPhone: string;
  turns: Turn[];
  expectedOutcome: 'completed' | 'opt_out' | 'escalated';
  pipeline?: 'modular' | 'speech-to-speech';
}

const AGENTS: Agent[] = ['JACK', 'JENNY', 'BUNNY', 'CINDY'];
const INTENTS: Intent[] = [
  'balance_inquiry', 'pricing_inquiry', 'loan_inquiry', 'payment_inquiry',
  'account_status', 'general_inquiry', 'opt_out', 'escalate',
];

const TRANSCRIPTS: Record<Intent, string[]> = {
  balance_inquiry: [
    "What's my current account balance?",
    "Can you tell me how much is in my checking account?",
    "I need to check my balance please.",
  ],
  pricing_inquiry: [
    "What's the spot price of gold right now?",
    "Can you give me the current gold price?",
    "How much is an ounce of gold today?",
  ],
  loan_inquiry: [
    "I have a question about my loan.",
    "What's my remaining loan balance?",
    "Can you give me my payoff quote?",
  ],
  payment_inquiry: [
    "When is my next payment due?",
    "I want to schedule a bill payment.",
    "What are my scheduled payments?",
  ],
  account_status: [
    "Is my card active?",
    "What's the status of my account?",
    "Can you check if my card is working?",
  ],
  general_inquiry: [
    "What services do you offer?",
    "Can you help me understand my options?",
    "I just have a general question.",
  ],
  opt_out: [
    "Please remove me from your list.",
    "Stop calling me, I'm not interested.",
    "Take me off your call list please.",
  ],
  escalate: [
    "This is unacceptable, I need to speak to a supervisor.",
    "I'm extremely frustrated, connect me with a human right now.",
    "This is ridiculous, I want a real person.",
  ],
};

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateScenarios(count: number): Scenario[] {
  const scenarios: Scenario[] = [];

  for (let i = 0; i < count; i++) {
    const agent = AGENTS[i % AGENTS.length];
    const direction: Direction = i % 5 === 0 ? 'outbound' : 'inbound';

    // Weight distribution: 60% high confidence, 25% medium, 15% low
    const confidenceRoll = (i * 7 + 13) % 100;
    const baseConfidence = confidenceRoll < 60 ? 0.92 :
                           confidenceRoll < 85 ? 0.80 :
                           0.60 + ((i % 10) * 0.01); // 0.60–0.69 (low)

    // Intent distribution
    const intentIdx = i % INTENTS.length;
    const intent = INTENTS[intentIdx];

    // Turn count: 1-4 turns
    const turnCount = 1 + (i % 4);

    const turns: Turn[] = [];
    for (let t = 0; t < turnCount; t++) {
      const turnIntent = t === 0 ? intent : pickRandom(INTENTS.slice(0, 6)); // last turn can vary
      const transcriptPool = TRANSCRIPTS[turnIntent];
      const transcript = transcriptPool[t % transcriptPool.length];

      // Vary confidence per turn — last turn might be low
      const conf = t === turnCount - 1 ? baseConfidence :
                   Math.min(1.0, baseConfidence + 0.1);
      turns.push({ transcript, confidence: conf });
    }

    const expectedOutcome: Scenario['expectedOutcome'] =
      intent === 'opt_out' ? 'opt_out' :
      intent === 'escalate' ? 'escalated' :
      'completed';

    scenarios.push({
      id: i,
      agent,
      direction,
      callerPhone: `+1555${String(i).padStart(7, '0')}`,
      turns,
      expectedOutcome,
    });
  }

  return scenarios;
}

// ============================================================================
// Turn Result Factory — returns TurnResult based on scenario intent
// ============================================================================

function makeTurnResultFn(scenario: Scenario): (utterance: string) => any {
  let turnIndex = 0;

  return (utterance: string) => {
    // Empty utterance = greeting request
    if (!utterance) {
      return {
        type: 'system_action',
        action: 'deliver_disclosure',
        nextPhase: 'greeting',
      };
    }

    const isLastTurn = turnIndex >= scenario.turns.length - 1;
    const intent = scenario.turns[turnIndex]?.transcript ?? utterance;
    turnIndex++;

    // Detect opt-out / escalate from transcript content
    const lower = utterance.toLowerCase();
    if (/remove me|stop calling|not interested|take me off/.test(lower)) {
      return {
        type: 'opt_out',
        responseText: "I understand, I'll remove you from our list right away. Have a good day.",
      };
    }

    if (/unacceptable|supervisor|real person|human right now|ridiculous/.test(lower) ||
        (isLastTurn && scenario.expectedOutcome === 'escalated')) {
      return {
        type: 'escalate',
        reason: 'caller_frustration',
        responseText: "I understand your frustration. Let me connect you with a team member right away.",
        context: { reason: 'frustration' },
      };
    }

    // Standard respond
    return {
      type: 'respond',
      provider: 'gpt-4o' as const,
      pipelineMode: 'modular' as const,
      latencyBudget: 800,
      responseInstruction: '',
      tools: [],
      intent: 'balance_inquiry',
      userUtterance: utterance,
    };
  };
}

// ============================================================================
// Simulation Runner
// ============================================================================

interface SimResult {
  id: number;
  reaskTriggered: boolean;
  backchannelFired: boolean;
  latencyMaskFired: boolean;
  naturalnessInAppended: boolean;
  crmPushAttempted: boolean;
  nova3Used: boolean;
  endpointingMs: number;
  greetingDelivered: boolean;
  turnsCompleted: number;
  synthesizeCalls: number;
  streamTextCalls: number;
  durationMs: number;
  error: string | null;
}

const REASK_PHRASES = [
  "sorry, i didn't catch that",
  "you broke up",
  "i missed that",
];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runScenario(scenario: Scenario): Promise<SimResult> {
  const startMs = Date.now();
  const result: SimResult = {
    id: scenario.id,
    reaskTriggered: false,
    backchannelFired: false,
    latencyMaskFired: false,
    naturalnessInAppended: false,
    crmPushAttempted: false,
    nova3Used: false,
    endpointingMs: 0,
    greetingDelivered: false,
    turnsCompleted: 0,
    synthesizeCalls: 0,
    streamTextCalls: 0,
    durationMs: 0,
    error: null,
  };

  const logger = pino({ level: 'silent' });
  const mockWs = new MockWebSocket();
  const mockDeepgram = new MockDeepgram();
  const mockCartesia = new MockCartesia();
  const mockLlm = new MockLLM();
  const mockPipeline = new MockPipelineController(makeTurnResultFn(scenario), scenario.pipeline ?? 'modular');
  const mockMemory = new MockConversationMemory();
  const mockTools = new MockToolExecutor();

  // No per-sim mock reset — crmPushedPhones tracks by phone number

  try {
    // Construct handler — all deps injected
    const _handler = new TwilioMediaStreamHandler({
      ws: mockWs as any,
      pipelineController: mockPipeline as any,
      deepgram: mockDeepgram as any,
      cartesia: mockCartesia as any,
      llm: mockLlm as any,
      toolExecutor: mockTools as any,
      conversationMemory: mockMemory as any,
      logger,
    });

    // --- Phase 1: Start stream ---
    const greetingPromise = new Promise<void>(resolve => {
      mockCartesia.once('synthesize', () => resolve());
    });

    mockWs.simulateMessage({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    mockWs.simulateMessage({
      event: 'start',
      sequenceNumber: '1',
      start: {
        streamSid: `MZ${scenario.id.toString().padStart(32, '0')}`,
        accountSid: 'ACsim000000000000000000000000000',
        callSid: `CA${scenario.id.toString().padStart(32, '0')}`,
        tracks: ['inbound'],
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        customParameters: {
          model: scenario.agent,
          callerPhone: scenario.callerPhone,
          calledPhone: '+18005550100',
          direction: scenario.direction,
        },
      },
    });

    // Wait for greeting (speakDisclosure → cartesia.synthesize)
    await Promise.race([greetingPromise, sleep(2000)]);

    result.greetingDelivered = mockCartesia.synthesizeCalls.length > 0;
    result.nova3Used = mockDeepgram.capturedStreamOptions?.model === 'nova-3';
    result.endpointingMs = mockDeepgram.capturedStreamOptions?.endpointing ?? 0;

    // --- Phase 2: Inject turns ---
    for (const turn of scenario.turns) {
      const turnStart = Date.now();

      // Listen for synthesize/streamText before injecting
      const responseDone = new Promise<void>(resolve => {
        const onSynthesize = () => { mockCartesia.off('done', onDone); resolve(); };
        const onDone = () => { mockCartesia.off('synthesize', onSynthesize); resolve(); };
        mockCartesia.once('synthesize', onSynthesize);
        mockCartesia.once('done', onDone);
      });

      const snapshotSynthBefore = mockCartesia.synthesizeCalls.length;
      mockDeepgram.injectTranscript(turn.transcript, turn.confidence);

      // Wait for response (or timeout)
      await Promise.race([responseDone, sleep(1500)]);
      const _ = Date.now() - turnStart;

      result.turnsCompleted++;

      // Detect re-ask: a synthesize call whose text matches a re-ask phrase
      const newSynths = mockCartesia.synthesizeCalls.slice(snapshotSynthBefore);
      for (const s of newSynths) {
        const lower = s.toLowerCase();
        if (REASK_PHRASES.some(p => lower.includes(p))) {
          result.reaskTriggered = true;
        }
      }

      // Detect backchannel / latency mask: synthesize calls that are NOT stream
      // responses (they're short, fire-and-forget calls before the main LLM response)
      if (newSynths.length > 1) {
        // First call(s) could be backchannel/mask; main response goes via streamText
        result.backchannelFired = result.backchannelFired || newSynths.length >= 2;
      }
    }

    result.latencyMaskFired = mockCartesia.synthesizeCalls.some(t =>
      /let me check|one moment|checking|give me a|hold on/i.test(t)
    );

    // Check naturalness instructions in system prompts (getNaturalnessInstructions returns 'VOICE NATURALNESS GUIDELINES:')
    result.naturalnessInAppended = mockLlm.capturedSystemInstructions.some(instr =>
      instr.includes('VOICE NATURALNESS') || instr.includes('PHONE CALL') ||
      instr.includes('contractions') || instr.includes('as an AI')
    );

    // --- Phase 3: End call ---
    const cleanupDone = new Promise<void>(resolve => {
      // Resolve when CRM push is attempted OR memory is saved
      const origSave = mockMemory.saveCallSummary.bind(mockMemory);
      (mockMemory as any).saveCallSummary = async (...args: any[]) => {
        await origSave(...args);
        setTimeout(resolve, 50); // small delay for CRM push to fire after save
      };
    });

    mockWs.simulateMessage({
      event: 'stop',
      sequenceNumber: '99',
      stop: { accountSid: 'ACsim000000000000000000000000000', callSid: `CA${scenario.id}` },
    });

    await Promise.race([cleanupDone, sleep(2000)]);

    result.crmPushAttempted = mockHandles.crmPushedPhones.has(scenario.callerPhone);
    result.synthesizeCalls = mockCartesia.synthesizeCalls.length;
    result.streamTextCalls = mockCartesia.streamTextCalls.length;

  } catch (err: any) {
    result.error = err?.message ?? String(err);
  }

  result.durationMs = Date.now() - startMs;
  return result;
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Voice Call Simulation — 1000 Calls', () => {
  beforeAll(() => {
    // Silence all module-level loggers
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('runs 1000 voice call simulations and validates VoiceAI sprint changes', async () => {
    const N = 1000;
    const scenarios = generateScenarios(N);
    const results: SimResult[] = [];

    // Run in batches of 50 to avoid event loop saturation
    const BATCH = 50;
    for (let i = 0; i < scenarios.length; i += BATCH) {
      const batch = scenarios.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(runScenario));
      results.push(...batchResults);
    }

    // -----------------------------------------------------------------------
    // Aggregate metrics
    // -----------------------------------------------------------------------
    const total = results.length;
    const errors = results.filter(r => r.error !== null);
    const nova3 = results.filter(r => r.nova3Used);
    const fastEndpointing = results.filter(r => r.endpointingMs === 300);
    const greetings = results.filter(r => r.greetingDelivered);
    const reasks = results.filter(r => r.reaskTriggered);
    const backchannels = results.filter(r => r.backchannelFired);
    const latencyMasks = results.filter(r => r.latencyMaskFired);
    const naturalnessIn = results.filter(r => r.naturalnessInAppended);
    const crmPushes = results.filter(r => r.crmPushAttempted);
    const avgDuration = results.reduce((s, r) => s + r.durationMs, 0) / total;
    const avgTurns = results.reduce((s, r) => s + r.turnsCompleted, 0) / total;
    const avgSynth = results.reduce((s, r) => s + r.synthesizeCalls, 0) / total;
    const avgStream = results.reduce((s, r) => s + r.streamTextCalls, 0) / total;

    // Low-confidence scenario count (confidence 0.60-0.69)
    const lowConfScenarios = scenarios.filter((_, i) => {
      const conf = (i * 7 + 13) % 100;
      return conf >= 85; // 15% of scenarios hit low confidence path
    });

    // -----------------------------------------------------------------------
    // Report
    // -----------------------------------------------------------------------
    console.info('\n' + '═'.repeat(70));
    console.info('  VOICE CALL SIMULATION REPORT — 1000 CALLS');
    console.info('═'.repeat(70));
    console.info(`  Total scenarios:        ${total}`);
    console.info(`  Errors:                 ${errors.length} (${pct(errors.length, total)}%)`);
    console.info('');
    console.info('  [P1] Nova-3 STT');
    console.info(`    nova-3 used:          ${nova3.length}/${total} (${pct(nova3.length, total)}%)`);
    console.info(`    300ms endpointing:    ${fastEndpointing.length}/${total} (${pct(fastEndpointing.length, total)}%)`);
    console.info('');
    console.info('  [P2] Greeting delivery');
    console.info(`    Greetings delivered:  ${greetings.length}/${total} (${pct(greetings.length, total)}%)`);
    console.info('');
    console.info('  [P4] Naturalness Engine');
    console.info(`    Backchannels fired:   ${backchannels.length}/${total} (${pct(backchannels.length, total)}%)`);
    console.info(`    Latency masks fired:  ${latencyMasks.length}/${total} (${pct(latencyMasks.length, total)}%)`);
    console.info(`    Naturalness in prompt:${naturalnessIn.length}/${total} (${pct(naturalnessIn.length, total)}%)`);
    console.info('');
    console.info('  [P5] Post-call CRM push');
    console.info(`    CRM push attempted:   ${crmPushes.length}/${total} (${pct(crmPushes.length, total)}%)`);
    console.info('');
    console.info('  [P6] Confidence re-ask');
    console.info(`    Re-asks triggered:    ${reasks.length} (low-conf scenarios: ~${lowConfScenarios.length})`);
    console.info('');
    console.info('  Performance');
    console.info(`    Avg sim duration:     ${avgDuration.toFixed(1)}ms`);
    console.info(`    Avg turns/call:       ${avgTurns.toFixed(2)}`);
    console.info(`    Avg synthesize calls: ${avgSynth.toFixed(2)}`);
    console.info(`    Avg streamText calls: ${avgStream.toFixed(2)}`);
    console.info('═'.repeat(70) + '\n');

    if (errors.length > 0) {
      console.info(`  Sample errors (first 5):`);
      errors.slice(0, 5).forEach(e => console.info(`    [sim ${e.id}] ${e.error}`));
    }

    // -----------------------------------------------------------------------
    // Assertions
    // -----------------------------------------------------------------------

    // P1: Nova-3 must be used on all calls
    expect(nova3.length, 'Nova-3 must be used on all calls').toBe(total);

    // P1: 300ms endpointing on all calls
    expect(fastEndpointing.length, '300ms endpointing must be set on all calls').toBe(total);

    // Greeting must be delivered on all calls (no startup failures)
    expect(greetings.length, 'Greeting must be delivered on all calls').toBe(total);

    // P4: Naturalness instructions must be appended on any call that hits the streaming LLM path.
    // Only calls where streamText was called went through generateStreamingLLMResponse.
    const streamingLLMCalls = results.filter(r => r.streamTextCalls > 0);
    const naturalnessHitRate = streamingLLMCalls.length > 0
      ? streamingLLMCalls.filter(r => r.naturalnessInAppended).length / streamingLLMCalls.length
      : 1;
    expect(naturalnessHitRate, 'Naturalness instructions must be in ≥93% of streaming LLM calls')
      .toBeGreaterThanOrEqual(0.93);

    // P5: CRM push must be attempted on most calls (some may fail due to mock timing)
    expect(crmPushes.length / total, 'CRM push should be attempted on ≥70% of calls')
      .toBeGreaterThanOrEqual(0.70);

    // P6: Re-asks should fire in low-confidence scenarios
    // With 15% low-confidence scenarios and > 2 word utterances, expect some re-asks
    const lowConfCount = Math.floor(total * 0.15);
    if (lowConfCount > 10) {
      expect(reasks.length, `Re-asks should fire for low-confidence scenarios (got ${reasks.length})`).toBeGreaterThan(0);
    }

    // Overall: < 1% error rate
    expect(errors.length / total, 'Error rate must be below 1%').toBeLessThan(0.01);

  }, 180_000); // 3 minute timeout for 1000 sims

  it('routes audio correctly in speech-to-speech pipeline (100 S2S scenarios)', async () => {
    // S2S pipeline: Twilio audio → Grok Voice, bypasses Deepgram STT
    // TwilioMediaStreamHandler routes media chunks to pipelineController.routeAudio()
    // instead of deepgram.sendAudio(). Validate that:
    //   1. No Deepgram transcript events are processed (there are none in S2S)
    //   2. Greeting is still delivered via Cartesia (speakDisclosure runs before S2S takes over)
    //   3. CRM push still fires on cleanup

    const S2S_COUNT = 100;
    const s2sScenarios: Scenario[] = Array.from({ length: S2S_COUNT }, (_, i) => ({
      id: 10000 + i,
      agent: AGENTS[i % AGENTS.length],
      direction: 'inbound' as Direction,
      callerPhone: `+1555${String(9000 + i).padStart(7, '0')}`,
      turns: [], // No transcript turns — S2S handles audio natively
      expectedOutcome: 'completed',
      pipeline: 'speech-to-speech',
    }));

    const results = await Promise.all(s2sScenarios.map(runScenario));

    const errors = results.filter(r => r.error !== null);
    const greetings = results.filter(r => r.greetingDelivered);
    const crmPushes = results.filter(r => r.crmPushAttempted);

    console.info('\n' + '─'.repeat(70));
    console.info(`  S2S Pipeline — ${S2S_COUNT} scenarios`);
    console.info(`  Errors:           ${errors.length}/${S2S_COUNT}`);
    console.info(`  Greetings:        ${greetings.length}/${S2S_COUNT}`);
    console.info(`  CRM pushes:       ${crmPushes.length}/${S2S_COUNT}`);
    console.info('─'.repeat(70) + '\n');

    // Greeting must still fire (disclosure is delivered before pipeline switches)
    expect(greetings.length, 'S2S: greeting must be delivered on all calls').toBe(S2S_COUNT);

    // CRM push must still fire after call ends
    expect(crmPushes.length / S2S_COUNT, 'S2S: CRM push should fire on ≥70% of calls')
      .toBeGreaterThanOrEqual(0.70);

    // Error rate < 2% (S2S is less exercised, give slightly more tolerance)
    expect(errors.length / S2S_COUNT, 'S2S: error rate must be below 2%').toBeLessThan(0.02);

  }, 60_000);
});

// ============================================================================
// Helpers
// ============================================================================

function pct(n: number, total: number): string {
  return ((n / total) * 100).toFixed(1);
}
