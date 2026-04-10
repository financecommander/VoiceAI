/**
 * CostGuard — Token Budget Enforcement + Circuit Breaker
 *
 * Two jobs:
 *   1. Budget: tracks daily cumulative token spend per provider.
 *              Blocks calls when daily cap is exceeded and fires webhook alerts.
 *   2. Circuit: tracks consecutive errors per provider.
 *              Trips breaker after N failures, holds it for a cooldown period.
 *              Auto-resets so the system self-heals.
 *
 * Backed by Redis. If Redis is unavailable, falls back to in-memory
 * (single-process only, resets on restart — acceptable degraded state).
 *
 * Usage (in LLMService):
 *   const guard = new CostGuard(redis, logger);
 *
 *   // Before calling a provider:
 *   const check = await guard.checkBudget('openai', agentId);
 *   if (!check.allowed) throw new Error(check.reason);
 *   if (await guard.isCircuitOpen('openai')) throw new Error('Circuit open');
 *
 *   // After a successful call:
 *   await guard.recordUsage('openai', agentId, response.tokensUsed);
 *   await guard.recordSuccess('openai');
 *
 *   // After a failed call:
 *   await guard.recordError('openai');
 */

import type { Logger } from 'pino';

// ============================================================================
// Config
// ============================================================================

export interface CostGuardConfig {
  /** Max tokens per provider per day (across all agents). 0 = unlimited. */
  dailyTokenLimitPerProvider: Record<string, number>;

  /** Max total tokens per day across all providers. 0 = unlimited. */
  dailyTokenLimitTotal: number;

  /** Max tokens per agent per day. 0 = unlimited. */
  dailyTokenLimitPerAgent: number;

  /** Alert at these % thresholds (e.g. [50, 80, 100]) */
  alertThresholds: number[];

  /** Webhook URL for cost alerts (Slack/Discord/custom) */
  alertWebhook: string;

  /** Circuit breaker: trip after this many consecutive errors */
  circuitBreakerThreshold: number;

  /** Circuit breaker: cooldown in seconds after tripping */
  circuitBreakerCooldownSeconds: number;

  /** Circuit breaker: error window in seconds */
  circuitBreakerWindowSeconds: number;
}

export const DEFAULT_COST_GUARD_CONFIG: CostGuardConfig = {
  dailyTokenLimitPerProvider: {
    'openai':    500_000,   // ~$15/day at GPT-4o pricing
    'anthropic': 300_000,   // ~$9/day at Claude Sonnet pricing
    'xai':       500_000,
    'portal':    800_000,   // Combined limit when routing through ai-portal
  },
  dailyTokenLimitTotal:    1_500_000,
  dailyTokenLimitPerAgent:   200_000,  // No single agent blows the budget
  alertThresholds:           [50, 80, 95, 100],
  alertWebhook:              process.env.COST_ALERT_WEBHOOK ?? '',
  circuitBreakerThreshold:   5,        // Trip after 5 consecutive errors
  circuitBreakerCooldownSeconds: 60,   // Hold for 60 seconds
  circuitBreakerWindowSeconds:   30,   // Count errors within 30-second window
};

// ============================================================================
// Redis interface (thin — works with ioredis or any compatible client)
// ============================================================================

interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode?: string, time?: number): Promise<unknown>;
  incr(key: string): Promise<number>;
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

// ============================================================================
// Budget check result
// ============================================================================

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  tokensUsedToday: number;
  dailyLimit: number;
  percentUsed: number;
}

// ============================================================================
// CostGuard
// ============================================================================

export class CostGuard {
  private config: CostGuardConfig;
  private redis: RedisClient | null;
  private logger: Logger;

  // In-memory fallback (single-process, resets on restart)
  private memTokens: Map<string, number> = new Map();
  private memErrors: Map<string, number[]> = new Map();
  private memCircuit: Map<string, number> = new Map(); // provider → trip timestamp

  // Track which thresholds we've already alerted on (don't spam)
  private alertedThresholds: Map<string, Set<number>> = new Map();

  constructor(redis: RedisClient | null, logger: Logger, config?: Partial<CostGuardConfig>) {
    this.redis = redis;
    this.logger = logger.child({ component: 'CostGuard' });
    this.config = { ...DEFAULT_COST_GUARD_CONFIG, ...config };
  }

  // --------------------------------------------------------------------------
  // Budget: check before calling a provider
  // --------------------------------------------------------------------------

  async checkBudget(provider: string, agentId: string): Promise<BudgetCheckResult> {
    const today = this.todayKey();

    // Check provider daily limit
    const providerLimit = this.config.dailyTokenLimitPerProvider[provider] ?? 0;
    if (providerLimit > 0) {
      const providerTokens = await this.getTokenCount(`cost:${today}:provider:${provider}`);
      if (providerTokens >= providerLimit) {
        const result = this.blocked(providerTokens, providerLimit,
          `Daily token limit reached for provider ${provider}`);
        await this.fireAlert('provider_limit_reached', provider, providerTokens, providerLimit);
        return result;
      }
    }

    // Check per-agent daily limit
    const agentLimit = this.config.dailyTokenLimitPerAgent;
    if (agentLimit > 0) {
      const agentTokens = await this.getTokenCount(`cost:${today}:agent:${agentId}`);
      if (agentTokens >= agentLimit) {
        return this.blocked(agentTokens, agentLimit,
          `Daily token limit reached for agent ${agentId}`);
      }
    }

    // Check total daily limit
    const totalLimit = this.config.dailyTokenLimitTotal;
    if (totalLimit > 0) {
      const totalTokens = await this.getTokenCount(`cost:${today}:total`);
      if (totalTokens >= totalLimit) {
        const result = this.blocked(totalTokens, totalLimit,
          'Total daily token budget exhausted — all providers blocked');
        await this.fireAlert('total_limit_reached', 'all', totalTokens, totalLimit);
        return result;
      }
    }

    const providerTokens = await this.getTokenCount(`cost:${today}:provider:${provider}`);
    const effectiveLimit = providerLimit || this.config.dailyTokenLimitTotal;

    return {
      allowed: true,
      tokensUsedToday: providerTokens,
      dailyLimit: effectiveLimit,
      percentUsed: effectiveLimit > 0 ? Math.round((providerTokens / effectiveLimit) * 100) : 0,
    };
  }

  // --------------------------------------------------------------------------
  // Budget: record usage after a successful call
  // --------------------------------------------------------------------------

  async recordUsage(provider: string, agentId: string, tokensUsed: number): Promise<void> {
    if (tokensUsed <= 0) return;

    const today = this.todayKey();
    const ttl = 25 * 60 * 60; // 25h — covers timezone edge cases

    await Promise.all([
      this.incrementTokenCount(`cost:${today}:provider:${provider}`, tokensUsed, ttl),
      this.incrementTokenCount(`cost:${today}:agent:${agentId}`, tokensUsed, ttl),
      this.incrementTokenCount(`cost:${today}:total`, tokensUsed, ttl),
    ]);

    // Check thresholds and alert
    const providerLimit = this.config.dailyTokenLimitPerProvider[provider] ?? 0;
    if (providerLimit > 0) {
      const newTotal = await this.getTokenCount(`cost:${today}:provider:${provider}`);
      await this.checkThresholdAlerts(provider, newTotal, providerLimit);
    }
  }

  // --------------------------------------------------------------------------
  // Budget: get current daily spend summary
  // --------------------------------------------------------------------------

  async getDailySummary(): Promise<Record<string, number>> {
    const today = this.todayKey();
    const providers = Object.keys(this.config.dailyTokenLimitPerProvider);
    const summary: Record<string, number> = {};

    summary['total'] = await this.getTokenCount(`cost:${today}:total`);
    for (const provider of providers) {
      summary[provider] = await this.getTokenCount(`cost:${today}:provider:${provider}`);
    }

    return summary;
  }

  // --------------------------------------------------------------------------
  // Circuit breaker: check before calling a provider
  // --------------------------------------------------------------------------

  async isCircuitOpen(provider: string): Promise<boolean> {
    const tripKey = `circuit:${provider}:open`;

    if (this.redis) {
      const tripped = await this.redis.get(tripKey);
      return tripped === '1';
    }

    // In-memory fallback
    const tripTime = this.memCircuit.get(provider);
    if (!tripTime) return false;
    if (Date.now() - tripTime > this.config.circuitBreakerCooldownSeconds * 1000) {
      this.memCircuit.delete(provider);
      return false;
    }
    return true;
  }

  // --------------------------------------------------------------------------
  // Circuit breaker: record a successful call (resets error count)
  // --------------------------------------------------------------------------

  async recordSuccess(provider: string): Promise<void> {
    const errorKey = `circuit:${provider}:errors`;

    if (this.redis) {
      await this.redis.del(errorKey);
    } else {
      this.memErrors.delete(provider);
    }
  }

  // --------------------------------------------------------------------------
  // Circuit breaker: record a failed call
  // --------------------------------------------------------------------------

  async recordError(provider: string): Promise<void> {
    const errorKey = `circuit:${provider}:errors`;
    const tripKey  = `circuit:${provider}:open`;
    const window   = this.config.circuitBreakerWindowSeconds;
    const threshold = this.config.circuitBreakerThreshold;
    const cooldown  = this.config.circuitBreakerCooldownSeconds;

    let errorCount: number;

    if (this.redis) {
      errorCount = await this.redis.incr(errorKey);
      // First error starts the window
      if (errorCount === 1) {
        await this.redis.expire(errorKey, window);
      }
    } else {
      // In-memory: track timestamps within the window
      const now = Date.now();
      const cutoff = now - window * 1000;
      const existing = (this.memErrors.get(provider) ?? []).filter(t => t > cutoff);
      existing.push(now);
      this.memErrors.set(provider, existing);
      errorCount = existing.length;
    }

    if (errorCount >= threshold) {
      this.logger.warn({ provider, errorCount }, 'Circuit breaker TRIPPED');

      if (this.redis) {
        await this.redis.set(tripKey, '1', 'EX', cooldown);
      } else {
        this.memCircuit.set(provider, Date.now());
      }

      await this.fireAlert('circuit_tripped', provider, errorCount, threshold);
    }
  }

  // --------------------------------------------------------------------------
  // Alert webhook
  // --------------------------------------------------------------------------

  private async fireAlert(
    event: string,
    provider: string,
    current: number,
    limit: number,
  ): Promise<void> {
    if (!this.config.alertWebhook) return;

    const pct = limit > 0 ? Math.round((current / limit) * 100) : 0;
    const msg = event === 'circuit_tripped'
      ? `🚨 *Circuit breaker tripped*: \`${provider}\` — ${current} consecutive errors. Cooldown: ${this.config.circuitBreakerCooldownSeconds}s`
      : `⚠️ *Cost alert* [\`${event}\`]: \`${provider}\` at ${pct}% of daily limit (${current.toLocaleString()} / ${limit.toLocaleString()} tokens)`;

    try {
      await fetch(this.config.alertWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: msg }),
      });
    } catch (err) {
      this.logger.warn({ err }, 'Failed to send cost alert webhook');
    }
  }

  private async checkThresholdAlerts(
    provider: string,
    used: number,
    limit: number,
  ): Promise<void> {
    const pct = Math.round((used / limit) * 100);
    const alerted = this.alertedThresholds.get(provider) ?? new Set();

    for (const threshold of this.config.alertThresholds) {
      if (pct >= threshold && !alerted.has(threshold)) {
        alerted.add(threshold);
        this.alertedThresholds.set(provider, alerted);
        await this.fireAlert('threshold_reached', provider, used, limit);
      }
    }

    // Reset thresholds at midnight (new day key means new Map entry anyway)
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  }

  private blocked(used: number, limit: number, reason: string): BudgetCheckResult {
    this.logger.warn({ used, limit, reason }, 'CostGuard blocked LLM call');
    return {
      allowed: false,
      reason,
      tokensUsedToday: used,
      dailyLimit: limit,
      percentUsed: Math.round((used / limit) * 100),
    };
  }

  private async getTokenCount(key: string): Promise<number> {
    if (this.redis) {
      const val = await this.redis.get(key);
      return val ? parseInt(val, 10) : 0;
    }
    return this.memTokens.get(key) ?? 0;
  }

  private async incrementTokenCount(key: string, amount: number, ttl: number): Promise<void> {
    if (this.redis) {
      await this.redis.incrby(key, amount);
      await this.redis.expire(key, ttl);
    } else {
      this.memTokens.set(key, (this.memTokens.get(key) ?? 0) + amount);
    }
  }
}
