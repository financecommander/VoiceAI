/**
 * Conversation Memory Service — Persistent caller history for returning callers
 *
 * Stores call summaries keyed by caller phone number in a local JSON file
 * with an in-memory cache. Enables Jack/Jenny to recognise returning callers
 * and personalise greetings based on prior interactions.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface CallSummary {
  date: string;
  agent: string;
  durationSec: number;
  topicsDiscussed: string[];
  outcome: string;          // e.g. "resolved", "escalated", "callback_scheduled"
  sentiment: 'positive' | 'neutral' | 'negative';
  notes: string;            // Brief summary of the call
}

export interface CallerMemory {
  phone: string;
  name: string | null;
  callCount: number;
  firstCallDate: string;
  lastCallDate: string;
  lastAgent: string;
  topics: string[];                     // Deduped list of all topics discussed
  preferences: Record<string, string>;  // e.g. { "preferred_name": "Sean", "timezone": "EST" }
  recentSummaries: CallSummary[];       // Last 5 call summaries
}

/** Shape of the on-disk JSON store */
interface MemoryStore {
  version: number;
  callers: Record<string, CallerMemory>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RECENT_SUMMARIES = 5;
const DEFAULT_STORE_PATH = '/opt/voiceai/data/memory.json';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ConversationMemoryService {
  private logger: Logger;
  private storePath: string;
  private cache: MemoryStore | null = null;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(logger: Logger, storePath?: string) {
    this.logger = logger.child({ component: 'ConversationMemory' });
    this.storePath = storePath ?? DEFAULT_STORE_PATH;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Retrieve the full caller context for a given phone number.
   * Returns null if the caller has never been seen before.
   */
  async getCallerContext(phone: string): Promise<CallerMemory | null> {
    const store = await this.loadStore();
    const normalized = this.normalizePhone(phone);
    return store.callers[normalized] ?? null;
  }

  /**
   * Persist a call summary after a call ends.
   * Creates the caller record if this is the first interaction.
   */
  async saveCallSummary(phone: string, summary: CallSummary): Promise<void> {
    const normalized = this.normalizePhone(phone);

    await this.withLock(async () => {
      const store = await this.loadStore();
      const existing = store.callers[normalized];

      if (existing) {
        existing.callCount += 1;
        existing.lastCallDate = summary.date;
        existing.lastAgent = summary.agent;

        // Merge topics (deduped)
        const topicSet = new Set(existing.topics);
        for (const t of summary.topicsDiscussed) {
          topicSet.add(t);
        }
        existing.topics = Array.from(topicSet);

        // Append summary, keep only the most recent N
        existing.recentSummaries.push(summary);
        if (existing.recentSummaries.length > MAX_RECENT_SUMMARIES) {
          existing.recentSummaries = existing.recentSummaries.slice(-MAX_RECENT_SUMMARIES);
        }
      } else {
        store.callers[normalized] = {
          phone: normalized,
          name: null,
          callCount: 1,
          firstCallDate: summary.date,
          lastCallDate: summary.date,
          lastAgent: summary.agent,
          topics: [...summary.topicsDiscussed],
          preferences: {},
          recentSummaries: [summary],
        };
      }

      await this.persistStore(store);
      this.logger.info({ phone: normalized, callCount: store.callers[normalized].callCount }, 'Call summary saved');
    });
  }

  /**
   * Generate a personalised greeting based on the caller's history.
   * Falls back to a generic greeting for first-time callers.
   */
  async getCallerGreeting(phone: string, agentName: string): Promise<string> {
    const memory = await this.getCallerContext(phone);

    if (!memory) {
      return `Hi there! Thanks for calling, this is ${agentName}. How can I help you today?`;
    }

    const displayName = memory.preferences['preferred_name'] ?? memory.name;
    const callCount = memory.callCount;
    const lastAgent = memory.lastAgent;

    // Build a contextual greeting
    const parts: string[] = [];

    if (displayName) {
      parts.push(`Hey ${displayName}, welcome back!`);
    } else {
      parts.push(`Hey, welcome back!`);
    }

    parts.push(`This is ${agentName}.`);

    if (callCount > 1) {
      parts.push(`Great to hear from you again — this is your call number ${callCount + 1} with us.`);
    }

    // Reference previous agent if different
    if (lastAgent && lastAgent !== agentName) {
      parts.push(`I see you last spoke with ${lastAgent}.`);
    }

    // Reference most recent topic if available
    const lastSummary = memory.recentSummaries[memory.recentSummaries.length - 1];
    if (lastSummary) {
      if (lastSummary.outcome === 'callback_scheduled') {
        parts.push(`I believe we had a callback scheduled — is that what you're calling about?`);
      } else if (lastSummary.outcome === 'escalated') {
        parts.push(`Last time your issue was escalated — let me see if I can help get that resolved.`);
      } else if (lastSummary.topicsDiscussed.length > 0) {
        const recentTopic = lastSummary.topicsDiscussed[0];
        parts.push(`Last time we chatted about ${recentTopic}. What can I do for you today?`);
      }
    }

    // If we haven't added a closing question yet, add one
    if (!parts[parts.length - 1].includes('?')) {
      parts.push(`How can I help you today?`);
    }

    return parts.join(' ');
  }

  /**
   * Update or add a preference for a caller (e.g. preferred name, timezone).
   * Creates the caller record if it doesn't exist.
   */
  async updateCallerPreference(phone: string, key: string, value: string): Promise<void> {
    const normalized = this.normalizePhone(phone);

    await this.withLock(async () => {
      const store = await this.loadStore();

      if (!store.callers[normalized]) {
        // Create a minimal record — they'll get a full record once a call summary is saved
        const now = new Date().toISOString();
        store.callers[normalized] = {
          phone: normalized,
          name: null,
          callCount: 0,
          firstCallDate: now,
          lastCallDate: now,
          lastAgent: '',
          topics: [],
          preferences: {},
          recentSummaries: [],
        };
      }

      store.callers[normalized].preferences[key] = value;

      // If setting preferred_name and no name is recorded, use it as the name too
      if (key === 'preferred_name' && !store.callers[normalized].name) {
        store.callers[normalized].name = value;
      }

      await this.persistStore(store);
      this.logger.debug({ phone: normalized, key, value }, 'Caller preference updated');
    });
  }

  // -----------------------------------------------------------------------
  // Internal — Store I/O
  // -----------------------------------------------------------------------

  /** Load the store from disk (or cache). */
  private async loadStore(): Promise<MemoryStore> {
    if (this.cache) return this.cache;

    try {
      const raw = await fs.readFile(this.storePath, 'utf-8');
      const parsed: MemoryStore = JSON.parse(raw);

      // Basic migration guard
      if (!parsed.version || !parsed.callers) {
        this.logger.warn('Memory store has unexpected shape — reinitialising');
        this.cache = this.emptyStore();
      } else {
        this.cache = parsed;
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        this.logger.info({ path: this.storePath }, 'Memory store not found — creating new one');
        this.cache = this.emptyStore();
        await this.ensureDirectory();
        await this.persistStore(this.cache);
      } else {
        this.logger.error({ error: err }, 'Failed to read memory store — starting fresh');
        this.cache = this.emptyStore();
      }
    }

    return this.cache;
  }

  /** Write the store to disk and update the cache. */
  private async persistStore(store: MemoryStore): Promise<void> {
    this.cache = store;
    await this.ensureDirectory();
    const data = JSON.stringify(store, null, 2);
    await fs.writeFile(this.storePath, data, 'utf-8');
  }

  /** Create the data directory if it doesn't exist. */
  private async ensureDirectory(): Promise<void> {
    const dir = dirname(this.storePath);
    await fs.mkdir(dir, { recursive: true });
  }

  /** Return a blank store. */
  private emptyStore(): MemoryStore {
    return { version: 1, callers: {} };
  }

  // -----------------------------------------------------------------------
  // Internal — Concurrency
  // -----------------------------------------------------------------------

  /**
   * Simple async mutex — serialises all write operations so concurrent
   * calls don't clobber the JSON file or produce stale reads.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Wait for the previous write to finish, then hold the lock
    const previousLock = this.writeLock;
    this.writeLock = nextLock;

    await previousLock;

    try {
      // Invalidate cache so we re-read from disk inside the lock
      this.cache = null;
      return await fn();
    } finally {
      release!();
    }
  }

  // -----------------------------------------------------------------------
  // Internal — Helpers
  // -----------------------------------------------------------------------

  /** Strip formatting from phone numbers so lookups are consistent. */
  private normalizePhone(phone: string): string {
    // Remove everything except digits and leading +
    const stripped = phone.replace(/[^\d+]/g, '');
    // If it's a 10-digit US number without country code, prepend +1
    if (/^\d{10}$/.test(stripped)) {
      return `+1${stripped}`;
    }
    // Ensure leading + for international numbers
    if (!stripped.startsWith('+')) {
      return `+${stripped}`;
    }
    return stripped;
  }
}
