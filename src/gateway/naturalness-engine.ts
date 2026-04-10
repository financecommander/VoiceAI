/**
 * Conversational Naturalness Engine
 *
 * Makes AI voice calls indistinguishable from human calls by adding:
 *   1. Conversational fillers & micro-pauses ("um", "so", "let me think...")
 *   2. Breathing simulation (subtle inhale sounds between sentences)
 *   3. Backchannel responses ("mhm", "right", "yeah" while listening)
 *   4. Prosody variation / emotional mirroring (speed adjustments)
 *   5. Interruption recovery ("Oh sorry, go ahead")
 *   6. Latency masking ("Hmm, let me check on that...")
 *   7. Name usage & callback references
 *   8. Dynamic speaking rate (slower for important info, faster for casual)
 *
 * Works with both Cartesia TTS and OpenAI Realtime pipelines.
 */

import type { Logger } from 'pino';

// ============================================================================
// Types
// ============================================================================

export interface NaturalnessConfig {
  /** Enable/disable individual features */
  fillers: boolean;
  breathing: boolean;
  backchannel: boolean;
  prosodyVariation: boolean;
  interruptionRecovery: boolean;
  latencyMasking: boolean;
  nameUsage: boolean;
  dynamicRate: boolean;

  /** Filler frequency (0.0 = never, 1.0 = every response) */
  fillerFrequency: number;
  /** Backchannel frequency (0.0 = never, 1.0 = every pause) */
  backchannelFrequency: number;
  /** Base speaking speed (1.0 = normal) */
  baseSpeed: number;
}

export const DEFAULT_NATURALNESS_CONFIG: NaturalnessConfig = {
  fillers: true,
  breathing: true,
  backchannel: true,
  prosodyVariation: true,
  interruptionRecovery: true,
  latencyMasking: true,
  nameUsage: true,
  dynamicRate: true,
  fillerFrequency: 0.3,      // 30% of responses get a filler
  backchannelFrequency: 0.25, // 25% of caller pauses get a backchannel
  baseSpeed: 1.0,
};

export type EmotionalTone = 'neutral' | 'warm' | 'excited' | 'calm' | 'empathetic' | 'serious';

/** What the engine analyzed about the caller's turn */
export interface TurnAnalysis {
  /** Detected emotional tone */
  tone: EmotionalTone;
  /** Whether this is a question */
  isQuestion: boolean;
  /** Whether this seems like important/complex content */
  isComplex: boolean;
  /** Whether the caller seems to be in a hurry */
  isUrgent: boolean;
  /** Key topics mentioned */
  topics: string[];
  /** Recommended speaking speed for the response */
  recommendedSpeed: number;
}

// ============================================================================
// Filler & Breathing Pools
// ============================================================================

/** Conversational fillers — injected before responses to feel human */
const FILLERS = {
  /** Quick thinking fillers (100-300ms equivalent) */
  quick: [
    'So, ',
    'Well, ',
    'Okay, ',
    'Right, ',
    'Sure, ',
    'Ah, ',
  ],
  /** Longer thinking fillers (300-600ms equivalent) */
  thinking: [
    'Hmm, let me see... ',
    'Let me think about that... ',
    'That\'s a good question... ',
    'Okay, so... ',
    'Right, so... ',
  ],
  /** Transition fillers between topics */
  transition: [
    'So, ',
    'Anyway, ',
    'Now, ',
    'Also, ',
    'And, ',
  ],
};

/** Breathing markers — Cartesia interprets these as natural pauses */
const BREATH_MARKERS = {
  /** Short breath between clauses */
  short: '... ',
  /** Longer breath between sentences */
  long: '... ... ',
};

/** Backchannel responses — brief listening signals */
const BACKCHANNELS = [
  'Mhm.',
  'Right.',
  'Yeah.',
  'Okay.',
  'Got it.',
  'Sure.',
  'I see.',
  'Uh huh.',
];

/** Latency masking phrases — spoken while LLM thinks */
const LATENCY_MASKS = {
  /** For general questions */
  general: [
    'Hmm, let me check on that...',
    'One sec...',
    'Let me look into that...',
    'Sure, give me just a moment...',
  ],
  /** For complex questions that need longer processing */
  complex: [
    'That\'s a great question, let me think about that...',
    'Hmm, okay, let me work through that...',
    'Right, let me figure this out for you...',
  ],
  /** For returning to topic after interruption */
  resuming: [
    'So, where was I...',
    'Right, so as I was saying...',
    'Okay, so...',
  ],
};

/** Interruption recovery phrases */
const INTERRUPTION_RESPONSES = [
  'Oh, sorry — go ahead.',
  'Oh, please go ahead.',
  'Sure, go ahead.',
  'Sorry, what were you saying?',
  'Go ahead, I\'m listening.',
];

// ============================================================================
// Naturalness Engine
// ============================================================================

export class ConversationalNaturalnessEngine {
  private config: NaturalnessConfig;
  private logger: Logger;

  // Conversation state
  private callerName: string | null = null;
  private agentName: string = 'Jack';
  private turnCount: number = 0;
  private lastCallerTopics: string[] = [];
  private nameUsageCount: number = 0;
  private wasInterrupted: boolean = false;
  private lastInterruptedText: string | null = null;
  private conversationHistory: { role: 'caller' | 'agent'; summary: string }[] = [];

  constructor(config?: Partial<NaturalnessConfig>, logger?: Logger) {
    this.config = { ...DEFAULT_NATURALNESS_CONFIG, ...config };
    this.logger = logger?.child({ component: 'Naturalness' }) ?? console as any;
  }

  // ==========================================================================
  // Configuration
  // ==========================================================================

  setCallerName(name: string): void {
    this.callerName = name;
  }

  setAgentName(name: string): void {
    this.agentName = name;
  }

  /** Record that the agent was interrupted mid-speech */
  recordInterruption(interruptedText: string): void {
    this.wasInterrupted = true;
    this.lastInterruptedText = interruptedText;
  }

  /** Record a conversation turn for context tracking */
  recordTurn(role: 'caller' | 'agent', text: string): void {
    this.conversationHistory.push({
      role,
      summary: text.substring(0, 100),
    });
    // Keep last 20 turns
    if (this.conversationHistory.length > 20) {
      this.conversationHistory.shift();
    }
    if (role === 'caller') {
      this.turnCount++;
    }
  }

  // ==========================================================================
  // 1. Analyze Caller Turn
  // ==========================================================================

  /**
   * Analyze the caller's turn to determine tone, complexity, and recommended
   * response style. This drives prosody variation and dynamic rate.
   */
  analyzeTurn(transcript: string): TurnAnalysis {
    const lower = transcript.toLowerCase();

    // Detect emotional tone
    let tone: EmotionalTone = 'neutral';
    if (/\b(frustrated|angry|ridiculous|unacceptable|terrible|horrible)\b/.test(lower)) {
      tone = 'empathetic';
    } else if (/\b(great|awesome|perfect|wonderful|love|amazing|thank)\b/.test(lower)) {
      tone = 'warm';
    } else if (/\b(urgent|asap|emergency|immediately|right now|hurry)\b/.test(lower)) {
      tone = 'serious';
    } else if (/!{2,}/.test(transcript) || transcript === transcript.toUpperCase() && transcript.length > 10) {
      tone = 'excited';
    } else if (/\b(sad|sorry|unfortunately|lost|passed away|died)\b/.test(lower)) {
      tone = 'empathetic';
    }

    // Detect question
    const isQuestion = /\?/.test(transcript) || /^(what|how|when|where|who|why|can|could|would|is|are|do|does)\b/i.test(transcript.trim());

    // Detect complexity
    const isComplex = transcript.split(' ').length > 25
      || /\b(explain|how does|what if|compare|difference|between)\b/.test(lower)
      || /\b(calculate|estimate|figure out|break down)\b/.test(lower);

    // Detect urgency
    const isUrgent = /\b(urgent|asap|emergency|immediately|right now|hurry|quick)\b/.test(lower);

    // Extract topics
    const topics: string[] = [];
    if (/\b(loan|mortgage|payment|rate|interest)\b/.test(lower)) topics.push('lending');
    if (/\b(account|balance|transfer|wire)\b/.test(lower)) topics.push('banking');
    if (/\b(gold|silver|metal|price|spot)\b/.test(lower)) topics.push('precious_metals');
    if (/\b(settlement|closing|title|escrow)\b/.test(lower)) topics.push('settlement');
    this.lastCallerTopics = topics;

    // Calculate recommended speaking speed
    let recommendedSpeed = this.config.baseSpeed;
    if (isComplex || tone === 'empathetic') {
      recommendedSpeed *= 0.9; // Slower for complex or sensitive topics
    } else if (isUrgent) {
      recommendedSpeed *= 1.05; // Slightly faster for urgent
    } else if (tone === 'warm' || tone === 'excited') {
      recommendedSpeed *= 1.02; // Tiny bit livelier
    }

    return { tone, isQuestion, isComplex, isUrgent, topics, recommendedSpeed };
  }

  // ==========================================================================
  // 2. Get Latency Mask (spoken while LLM thinks)
  // ==========================================================================

  /**
   * Get a filler phrase to speak while the LLM generates a response.
   * Returns null if no masking is needed for this turn.
   */
  getLatencyMask(analysis: TurnAnalysis): string | null {
    if (!this.config.latencyMasking) return null;

    // First turn doesn't need masking (greeting is pre-prepared)
    if (this.turnCount <= 1) return null;

    // If we were interrupted, use a resuming phrase
    if (this.wasInterrupted) {
      this.wasInterrupted = false;
      return this.pickRandom(LATENCY_MASKS.resuming);
    }

    // Complex questions always get a mask
    if (analysis.isComplex) {
      return this.pickRandom(LATENCY_MASKS.complex);
    }

    // Regular questions get a mask ~40% of the time
    if (analysis.isQuestion && Math.random() < 0.4) {
      return this.pickRandom(LATENCY_MASKS.general);
    }

    return null;
  }

  // ==========================================================================
  // 3. Get Backchannel Response
  // ==========================================================================

  /**
   * Get a brief listening signal to emit during caller pauses.
   * Returns null if no backchannel is appropriate.
   */
  getBackchannel(): string | null {
    if (!this.config.backchannel) return null;
    if (Math.random() > this.config.backchannelFrequency) return null;
    return this.pickRandom(BACKCHANNELS);
  }

  // ==========================================================================
  // 4. Get Interruption Recovery
  // ==========================================================================

  /**
   * Get a natural response after being interrupted.
   * Returns null if the agent wasn't interrupted.
   */
  getInterruptionRecovery(): string | null {
    if (!this.config.interruptionRecovery || !this.wasInterrupted) return null;
    this.wasInterrupted = false;
    return this.pickRandom(INTERRUPTION_RESPONSES);
  }

  // ==========================================================================
  // 5. Enhance Response Text (fillers, breathing, name usage)
  // ==========================================================================

  /**
   * Process LLM response text to add natural conversational elements.
   * This is the main text transformation pipeline.
   */
  enhanceResponse(text: string, analysis: TurnAnalysis): string {
    let enhanced = text;

    // 1. Add filler at start of response
    if (this.config.fillers && Math.random() < this.config.fillerFrequency) {
      const fillerType = analysis.isComplex ? 'thinking'
        : this.turnCount > 1 ? 'transition'
        : 'quick';
      const filler = this.pickRandom(FILLERS[fillerType]);
      // Only add filler if response doesn't already start with one
      if (!/^(so|well|okay|right|hmm|sure|ah|um|let me)/i.test(enhanced.trim())) {
        enhanced = filler + enhanced.charAt(0).toLowerCase() + enhanced.slice(1);
      }
    }

    // 2. Add breathing pauses between sentences
    if (this.config.breathing) {
      enhanced = this.addBreathingPauses(enhanced);
    }

    // 3. Sprinkle caller's name (2-3 times per call, not every response)
    if (this.config.nameUsage && this.callerName && this.nameUsageCount < 3) {
      enhanced = this.maybeInsertName(enhanced);
    }

    return enhanced;
  }

  /**
   * Insert subtle breathing pauses between sentences.
   * Cartesia renders "..." as a natural pause.
   */
  private addBreathingPauses(text: string): string {
    // Add a micro-pause after the first sentence (breath before continuing)
    const sentences = text.split(/(?<=[.!?])\s+/);
    if (sentences.length <= 1) return text;

    return sentences.map((s, i) => {
      if (i === 0) return s;
      // 60% chance of a breath between sentences
      if (Math.random() < 0.6) {
        return BREATH_MARKERS.short + s;
      }
      return s;
    }).join(' ');
  }

  /**
   * Naturally insert the caller's name into the response.
   * Only does this occasionally (2-3 times per call).
   */
  private maybeInsertName(text: string): string {
    if (!this.callerName) return text;

    // Only insert name ~30% of the time it's possible
    if (Math.random() > 0.3) return text;

    // Don't use name if it's already in the text
    if (text.includes(this.callerName)) {
      this.nameUsageCount++;
      return text;
    }

    // Insert at natural points
    const insertionPoints = [
      // "Great question, {name}."
      { pattern: /^(Great|Good|That's a great|Excellent|Perfect)([^.!?]+)([.!?])/, replacement: `$1$2, ${this.callerName}$3` },
      // "{Name}, let me..."
      { pattern: /^(So|Well|Okay|Right|Sure),\s/, replacement: `$1, ${this.callerName}, ` },
      // "...for you, {name}."
      { pattern: /(for you)([.!?])/, replacement: `$1, ${this.callerName}$2` },
    ];

    for (const point of insertionPoints) {
      if (point.pattern.test(text)) {
        this.nameUsageCount++;
        return text.replace(point.pattern, point.replacement);
      }
    }

    return text;
  }

  // ==========================================================================
  // 6. Get Speaking Speed for Response
  // ==========================================================================

  /**
   * Get the recommended Cartesia speed parameter for this response.
   * Varies based on content type and emotional tone.
   */
  getSpeakingSpeed(text: string, analysis: TurnAnalysis): number {
    if (!this.config.dynamicRate) return this.config.baseSpeed;

    let speed = analysis.recommendedSpeed;

    // Lists get slightly slower with pauses
    if (/\d\.\s|•\s|-\s/.test(text) || (text.match(/,/g) ?? []).length > 3) {
      speed *= 0.95;
    }

    // Numbers and specific data = slower for clarity
    if (/\$[\d,]+|\d{3,}|\d+\.\d+%/.test(text)) {
      speed *= 0.92;
    }

    // Short casual responses = slightly faster
    if (text.split(' ').length < 15 && analysis.tone !== 'empathetic') {
      speed *= 1.03;
    }

    // Clamp to reasonable range
    return Math.max(0.85, Math.min(1.15, speed));
  }

  // ==========================================================================
  // 7. Build System Instructions with Naturalness Guidance
  // ==========================================================================

  /**
   * Generate LLM system instruction additions for natural conversation style.
   * Appended to the model's base instructions.
   */
  getNaturalnessInstructions(): string {
    const parts: string[] = [];

    parts.push(`VOICE NATURALNESS GUIDELINES:
- You are speaking on a PHONE CALL, not writing text. Speak like a real human in conversation.
- Use contractions naturally (I'm, you're, that's, we'll, don't, can't, won't).
- Use casual transitions: "So...", "Alright...", "Okay so...".
- Break long explanations into short sentences. No one speaks in paragraphs on the phone.
- For lists, say "first... second... and third..." rather than bullet points.
- Use filler sounds naturally: "hmm", "well", "you know".
- Express genuine reactions: "Oh that's great!", "Ah I see", "Right, right".
- Match the caller's energy level. If they're casual, be casual. If they're formal, be professional.
- NEVER say "as an AI" or "I'm an artificial intelligence" — you are ${this.agentName}.`);

    if (this.callerName) {
      parts.push(`- The caller's name is ${this.callerName}. Use it occasionally (not every sentence) to personalize the conversation.`);
    }

    if (this.conversationHistory.length > 0) {
      const recentCallerTopics = this.conversationHistory
        .filter(t => t.role === 'caller')
        .slice(-3)
        .map(t => t.summary);
      if (recentCallerTopics.length > 0) {
        parts.push(`- Recent topics the caller discussed: ${recentCallerTopics.join('; ')}. You can reference these naturally ("Like you mentioned earlier...").`);
      }
    }

    return parts.join('\n');
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  private pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /** Reset state for a new call */
  reset(): void {
    this.callerName = null;
    this.turnCount = 0;
    this.lastCallerTopics = [];
    this.nameUsageCount = 0;
    this.wasInterrupted = false;
    this.lastInterruptedText = null;
    this.conversationHistory = [];
  }
}
