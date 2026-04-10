/**
 * Outbound Intelligence Service — Proactive outbound call engine
 *
 * Triggers outbound calls based on business events such as missed payments,
 * appointment reminders, market alerts, and follow-ups. Calls are queued with
 * priority, scheduled within configurable call windows, and placed via Twilio
 * REST API with automatic retry and exponential backoff.
 *
 * Integration point: connects to the VoiceAI webhook so the receiving agent
 * (JACK, JENNY, etc.) gets full call context via custom TwiML parameters.
 *
 * Usage:
 *   const service = new OutboundIntelligenceService(config, logger);
 *   service.addTrigger({ type: 'missed_payment', priority: 'high', ... });
 *   // Scheduler runs automatically every 30s, or call processQueue() manually.
 */

import { v4 as uuid } from 'uuid';
import Twilio from 'twilio';
import type { Logger } from 'pino';
import type { CalcModel } from '../types.js';

// ============================================================================
// Interfaces
// ============================================================================

export interface OutboundTrigger {
  id: string;
  type: 'missed_payment' | 'appointment_reminder' | 'market_alert' | 'follow_up' | 'welcome' | 'custom';
  priority: 'high' | 'medium' | 'low';
  recipientPhone: string;
  recipientName?: string;
  agent: CalcModel;
  scheduledAt: Date;
  context: Record<string, unknown>;
  message?: string;
  maxAttempts: number;
  attemptCount: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  lastAttemptAt?: Date;
  createdAt: Date;
  completedAt?: Date;
  callSid?: string;
  failureReason?: string;
}

export interface OutboundConfig {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioFromNumbers: Record<string, string>;
  webhookBaseUrl: string;
  maxConcurrentCalls: number;
  callWindowStart: number;
  callWindowEnd: number;
  timezone: string;
}

export interface QueueStatus {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
}

type TriggerInput = Omit<OutboundTrigger, 'id' | 'status' | 'attemptCount' | 'createdAt'>;

// ============================================================================
// Priority weight for sorting — lower number = higher dispatch priority
// ============================================================================

const PRIORITY_WEIGHT: Record<OutboundTrigger['priority'], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

// ============================================================================
// Exponential backoff base (ms). Attempt n waits BASE * 2^(n-1).
// ============================================================================

const RETRY_BACKOFF_BASE_MS = 60_000; // 1 minute base
const MAX_BACKOFF_MS = 30 * 60_000;   // 30 minutes cap

// ============================================================================
// Service Implementation
// ============================================================================

export class OutboundIntelligenceService {
  private readonly config: OutboundConfig;
  private readonly logger: Logger;
  private readonly twilioClient: Twilio.Twilio;
  private readonly queue: Map<string, OutboundTrigger> = new Map();
  private schedulerHandle: ReturnType<typeof setInterval> | null = null;
  private activeCalls = 0;
  private disposed = false;

  constructor(config: OutboundConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: 'OutboundIntelligence' });
    this.twilioClient = Twilio(config.twilioAccountSid, config.twilioAuthToken);

    this.startScheduler();
    this.logger.info(
      {
        maxConcurrent: config.maxConcurrentCalls,
        callWindow: `${config.callWindowStart}:00–${config.callWindowEnd}:00 ${config.timezone}`,
      },
      'Outbound intelligence service initialized',
    );
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Queue a new outbound trigger. Returns the generated trigger ID.
   */
  addTrigger(input: TriggerInput): string {
    if (this.disposed) {
      throw new Error('OutboundIntelligenceService has been disposed');
    }

    const trigger: OutboundTrigger = {
      ...input,
      id: uuid(),
      status: 'pending',
      attemptCount: 0,
      createdAt: new Date(),
    };

    this.queue.set(trigger.id, trigger);
    this.logger.info(
      {
        triggerId: trigger.id,
        type: trigger.type,
        priority: trigger.priority,
        agent: trigger.agent,
        scheduledAt: trigger.scheduledAt.toISOString(),
        recipientPhone: this.redactPhone(trigger.recipientPhone),
      },
      'Outbound trigger queued',
    );

    return trigger.id;
  }

  /**
   * Process all eligible pending triggers. Called automatically by the
   * scheduler every 30 seconds, but can also be invoked manually.
   */
  async processQueue(): Promise<void> {
    if (this.disposed) return;

    const now = new Date();

    if (!this.isWithinCallWindow(now)) {
      this.logger.debug('Outside call window — skipping queue processing');
      return;
    }

    // Gather eligible triggers: pending, scheduled time has passed, and
    // backoff period (if retrying) has elapsed.
    const eligible = this.getEligibleTriggers(now);

    if (eligible.length === 0) return;

    this.logger.info({ eligible: eligible.length, activeCalls: this.activeCalls }, 'Processing outbound queue');

    for (const trigger of eligible) {
      if (this.activeCalls >= this.config.maxConcurrentCalls) {
        this.logger.warn(
          { maxConcurrent: this.config.maxConcurrentCalls },
          'Max concurrent calls reached — deferring remaining triggers',
        );
        break;
      }

      // Mark in-progress before the async call so concurrent processQueue
      // invocations won't double-dispatch.
      trigger.status = 'in_progress';
      trigger.attemptCount += 1;
      trigger.lastAttemptAt = now;
      this.activeCalls += 1;

      // Fire-and-forget per call — failures are handled inside placeCall.
      this.placeCall(trigger)
        .then((success) => {
          if (success) {
            trigger.status = 'completed';
            trigger.completedAt = new Date();
            this.logger.info({ triggerId: trigger.id }, 'Outbound call completed');
          } else {
            this.handleCallFailure(trigger, 'Call placement returned unsuccessful');
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.handleCallFailure(trigger, message);
        })
        .finally(() => {
          this.activeCalls = Math.max(0, this.activeCalls - 1);
        });
    }
  }

  /**
   * Place a single outbound call via the Twilio REST API. The call connects
   * to the VoiceAI webhook with custom parameters encoding trigger context so
   * the receiving agent has full situational awareness.
   */
  async placeCall(trigger: OutboundTrigger): Promise<boolean> {
    const fromNumber = this.resolveFromNumber(trigger.agent);
    if (!fromNumber) {
      this.logger.error(
        { agent: trigger.agent },
        'No Twilio from-number configured for agent — cannot place call',
      );
      return false;
    }

    // Build the TwiML webhook URL with query parameters so the receiving
    // handler can hydrate the agent with context.
    const webhookUrl = this.buildWebhookUrl(trigger);

    const statusCallbackUrl = new URL('/webhook/twilio/status', this.config.webhookBaseUrl).toString();

    this.logger.info(
      {
        triggerId: trigger.id,
        to: this.redactPhone(trigger.recipientPhone),
        from: this.redactPhone(fromNumber),
        agent: trigger.agent,
        type: trigger.type,
        attempt: trigger.attemptCount,
      },
      'Placing outbound call via Twilio',
    );

    try {
      const call = await this.twilioClient.calls.create({
        to: trigger.recipientPhone,
        from: fromNumber,
        url: webhookUrl,
        method: 'POST',
        statusCallback: statusCallbackUrl,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
        machineDetection: 'DetectMessageEnd',
        timeout: 30,
      });

      trigger.callSid = call.sid;
      this.logger.info(
        { triggerId: trigger.id, callSid: call.sid },
        'Twilio call initiated successfully',
      );

      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { triggerId: trigger.id, error: message },
        'Twilio API call failed',
      );
      return false;
    }
  }

  /**
   * Cancel a pending or in-progress trigger.
   */
  cancelTrigger(triggerId: string): void {
    const trigger = this.queue.get(triggerId);
    if (!trigger) {
      this.logger.warn({ triggerId }, 'Cancel requested for unknown trigger');
      return;
    }

    if (trigger.status === 'completed' || trigger.status === 'failed') {
      this.logger.warn(
        { triggerId, status: trigger.status },
        'Cannot cancel a trigger that is already terminal',
      );
      return;
    }

    trigger.status = 'cancelled';
    this.logger.info({ triggerId }, 'Outbound trigger cancelled');
  }

  /**
   * Return aggregate counts by status across the entire queue.
   */
  getQueueStatus(): QueueStatus {
    let pending = 0;
    let inProgress = 0;
    let completed = 0;
    let failed = 0;

    for (const trigger of this.queue.values()) {
      switch (trigger.status) {
        case 'pending':
          pending++;
          break;
        case 'in_progress':
          inProgress++;
          break;
        case 'completed':
          completed++;
          break;
        case 'failed':
          failed++;
          break;
        // cancelled triggers are intentionally excluded from counts
      }
    }

    return { pending, inProgress, completed, failed };
  }

  /**
   * Retrieve a trigger by ID (for status checks or external integrations).
   */
  getTrigger(triggerId: string): OutboundTrigger | undefined {
    return this.queue.get(triggerId);
  }

  /**
   * Gracefully stop the scheduler and prevent further processing.
   */
  dispose(): void {
    this.disposed = true;
    if (this.schedulerHandle) {
      clearInterval(this.schedulerHandle);
      this.schedulerHandle = null;
    }
    this.logger.info('Outbound intelligence service disposed');
  }

  // --------------------------------------------------------------------------
  // Private — Scheduling
  // --------------------------------------------------------------------------

  /**
   * Start a recurring interval that processes the queue every 30 seconds.
   */
  private startScheduler(): void {
    const INTERVAL_MS = 30_000;

    this.schedulerHandle = setInterval(() => {
      this.processQueue().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error({ error: message }, 'Unhandled error in queue processing cycle');
      });
    }, INTERVAL_MS);

    // Allow the Node process to exit even if the interval is still active.
    if (this.schedulerHandle.unref) {
      this.schedulerHandle.unref();
    }

    this.logger.debug({ intervalMs: INTERVAL_MS }, 'Outbound scheduler started');
  }

  // --------------------------------------------------------------------------
  // Private — Eligibility & Sorting
  // --------------------------------------------------------------------------

  /**
   * Return triggers that are eligible for dispatch right now, sorted by
   * priority (high first) then by scheduled time (earliest first).
   */
  private getEligibleTriggers(now: Date): OutboundTrigger[] {
    const eligible: OutboundTrigger[] = [];

    for (const trigger of this.queue.values()) {
      if (trigger.status !== 'pending') continue;
      if (trigger.scheduledAt > now) continue;

      // If this is a retry, ensure the backoff period has elapsed.
      if (trigger.attemptCount > 0 && trigger.lastAttemptAt) {
        const backoffMs = this.computeBackoff(trigger.attemptCount);
        const retryAfter = new Date(trigger.lastAttemptAt.getTime() + backoffMs);
        if (now < retryAfter) continue;
      }

      eligible.push(trigger);
    }

    // Sort: high priority first, then earliest scheduledAt.
    eligible.sort((a, b) => {
      const pw = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
      if (pw !== 0) return pw;
      return a.scheduledAt.getTime() - b.scheduledAt.getTime();
    });

    return eligible;
  }

  // --------------------------------------------------------------------------
  // Private — Call Window
  // --------------------------------------------------------------------------

  /**
   * Check whether the current time (in the configured timezone) falls within
   * the permitted call window.
   */
  private isWithinCallWindow(now: Date): boolean {
    const hour = this.getCurrentHourInTimezone(now);
    const { callWindowStart, callWindowEnd } = this.config;

    // Handle windows that span midnight (e.g., 22–06).
    if (callWindowStart <= callWindowEnd) {
      return hour >= callWindowStart && hour < callWindowEnd;
    }
    return hour >= callWindowStart || hour < callWindowEnd;
  }

  /**
   * Get the current hour (0–23) in the configured timezone.
   */
  private getCurrentHourInTimezone(now: Date): number {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: this.config.timezone,
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(formatter.format(now), 10);
  }

  // --------------------------------------------------------------------------
  // Private — Retry & Backoff
  // --------------------------------------------------------------------------

  /**
   * Compute exponential backoff in milliseconds for a given attempt number.
   * Attempt 1 = base, attempt 2 = 2x base, attempt 3 = 4x base, etc.
   * Capped at MAX_BACKOFF_MS.
   */
  private computeBackoff(attemptCount: number): number {
    const raw = RETRY_BACKOFF_BASE_MS * Math.pow(2, attemptCount - 1);
    // Add jitter: +/- 10% to prevent thundering herd on retries.
    const jitter = raw * 0.1 * (Math.random() * 2 - 1);
    return Math.min(raw + jitter, MAX_BACKOFF_MS);
  }

  /**
   * Handle a failed call attempt: either re-queue for retry or mark terminal.
   */
  private handleCallFailure(trigger: OutboundTrigger, reason: string): void {
    trigger.failureReason = reason;

    if (trigger.attemptCount < trigger.maxAttempts) {
      // Return to pending so the scheduler picks it up after backoff.
      trigger.status = 'pending';
      const nextBackoff = this.computeBackoff(trigger.attemptCount);
      this.logger.warn(
        {
          triggerId: trigger.id,
          attempt: trigger.attemptCount,
          maxAttempts: trigger.maxAttempts,
          nextRetryInMs: Math.round(nextBackoff),
          reason,
        },
        'Outbound call failed — will retry after backoff',
      );
    } else {
      trigger.status = 'failed';
      trigger.completedAt = new Date();
      this.logger.error(
        {
          triggerId: trigger.id,
          attempts: trigger.attemptCount,
          reason,
        },
        'Outbound call permanently failed — max attempts exhausted',
      );
    }
  }

  // --------------------------------------------------------------------------
  // Private — Twilio Helpers
  // --------------------------------------------------------------------------

  /**
   * Resolve the Twilio from-number for a given agent. Falls back to a
   * 'default' key if the agent has no dedicated number.
   */
  private resolveFromNumber(agent: CalcModel): string | undefined {
    return this.config.twilioFromNumbers[agent]
      ?? this.config.twilioFromNumbers['default'];
  }

  /**
   * Build the TwiML webhook URL that Twilio will request when the call
   * connects. Custom parameters are passed as query strings so the VoiceAI
   * inbound handler can hydrate the agent with full context.
   */
  private buildWebhookUrl(trigger: OutboundTrigger): string {
    const url = new URL('/webhook/twilio/outbound', this.config.webhookBaseUrl);

    url.searchParams.set('triggerId', trigger.id);
    url.searchParams.set('triggerType', trigger.type);
    url.searchParams.set('agent', trigger.agent);
    url.searchParams.set('priority', trigger.priority);

    if (trigger.recipientName) {
      url.searchParams.set('recipientName', trigger.recipientName);
    }
    if (trigger.message) {
      url.searchParams.set('message', trigger.message);
    }

    // Encode the full context object as a base64 JSON string so it survives
    // URL transport without encoding issues. Keep it under 2KB to stay within
    // Twilio's URL length limits.
    const contextJson = JSON.stringify(trigger.context);
    if (contextJson.length <= 2048) {
      const contextB64 = Buffer.from(contextJson).toString('base64');
      url.searchParams.set('context', contextB64);
    } else {
      // If context is too large, pass only the trigger ID and let the webhook
      // handler look up context from the queue.
      this.logger.warn(
        { triggerId: trigger.id, contextSize: contextJson.length },
        'Trigger context too large for URL — webhook will need to look up by triggerId',
      );
    }

    return url.toString();
  }

  /**
   * Redact a phone number for safe logging: +1234567890 -> +1***7890
   */
  private redactPhone(phone: string): string {
    if (phone.length <= 6) return '***';
    return phone.slice(0, 2) + '***' + phone.slice(-4);
  }
}
