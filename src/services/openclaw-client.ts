/**
 * OpenClaw Client — HTTP client for the OpenClaw AI Portal REST API
 *
 * Provides access to all OpenClaw tool categories:
 *   tools, reasoning, nlp, analytics, content, messaging, security,
 *   documents, growth, memory, orchestration, scheduler, web, crm, webhooks
 *
 * All methods are namespaced as openclaw_<category>_<action> to match
 * the tool naming convention used by the LLM tool dispatch system.
 *
 * Gracefully degrades when OpenClaw is unavailable — returns error
 * objects instead of throwing, so the voice agent can continue.
 */

import type { Logger } from 'pino';

// ============================================================================
// Configuration
// ============================================================================

export interface OpenClawConfig {
  /** Base URL for the OpenClaw API (default: http://fc-ai-portal:8100/api/v1/) */
  baseUrl: string;
  /** API key for authentication (optional — some deployments use network-level auth) */
  apiKey?: string;
  /** Request timeout in ms (default: 10000) */
  timeoutMs?: number;
}

const DEFAULT_CONFIG: OpenClawConfig = {
  baseUrl: process.env.OPENCLAW_API_URL ?? 'http://fc-ai-portal:8100/api/v1/',
  apiKey: process.env.OPENCLAW_API_KEY,
  timeoutMs: 10_000,
};

// ============================================================================
// OpenClaw Client
// ============================================================================

export class OpenClawClient {
  private config: OpenClawConfig;
  private logger: Logger;
  private _available: boolean | null = null;

  constructor(config?: Partial<OpenClawConfig>, logger?: Logger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Ensure baseUrl ends with /
    if (!this.config.baseUrl.endsWith('/')) {
      this.config.baseUrl += '/';
    }
    this.logger = (logger?.child({ component: 'OpenClawClient' }) ?? console) as Logger;
  }

  /** Check if OpenClaw API is reachable (cached after first check) */
  async isAvailable(): Promise<boolean> {
    if (this._available !== null) return this._available;
    try {
      const resp = await this.request('GET', 'health', undefined, 3000);
      this._available = resp !== null;
    } catch {
      this._available = false;
    }
    if (!this._available) {
      this.logger.warn('OpenClaw API is not available — OpenClaw tools will be disabled');
    }
    return this._available;
  }

  /** Reset availability cache (e.g., for retry after failure) */
  resetAvailability(): void {
    this._available = null;
  }

  // ==========================================================================
  // Generic HTTP Helper
  // ==========================================================================

  private async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    timeoutOverride?: number,
  ): Promise<unknown> {
    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutOverride ?? this.config.timeoutMs ?? 10_000,
    );

    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`OpenClaw API error ${resp.status}: ${text}`);
      }

      return await resp.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Dispatch an OpenClaw tool call by category and action.
   * This is the main entry point used by the ToolExecutor.
   */
  async dispatch(
    category: string,
    action: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const available = await this.isAvailable();
    if (!available) {
      return { error: 'OpenClaw API is not available', category, action };
    }

    this.logger.info({ category, action }, 'Dispatching OpenClaw tool call');

    try {
      const result = await this.callTool(category, action, args);
      return result;
    } catch (error) {
      this.logger.error({ category, action, error }, 'OpenClaw tool call failed');
      return {
        error: `OpenClaw ${category}.${action} failed: ${(error as Error).message}`,
        category,
        action,
      };
    }
  }

  // ==========================================================================
  // Category Routers
  // ==========================================================================

  private async callTool(
    category: string,
    action: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (category) {
      // --- Tools ---
      case 'tools':
        return this.request('POST', `tools/${action}`, args);

      // --- Reasoning ---
      case 'reasoning':
        return this.request('POST', `reasoning/${action}`, args);

      // --- NLP ---
      case 'nlp':
        return this.request('POST', `nlp/${action}`, args);

      // --- Analytics ---
      case 'analytics':
        return this.request('POST', `analytics/${action}`, args);

      // --- Content ---
      case 'content':
        return this.request('POST', `content/${action}`, args);

      // --- Messaging ---
      case 'messaging':
        return this.request('POST', `messaging/${action}`, args);

      // --- Security ---
      case 'security':
        return this.request('POST', `security/${action}`, args);

      // --- Documents ---
      case 'documents':
        return this.request('POST', `documents/${action}`, args);

      // --- Growth ---
      case 'growth':
        return this.request('POST', `growth/${action}`, args);

      // --- Memory ---
      case 'memory':
        return this.request('POST', `memory/${action}`, args);

      // --- Orchestration ---
      case 'orchestration':
        return this.request('POST', `orchestration/${action}`, args);

      // --- Scheduler ---
      case 'scheduler':
        if (action === 'list') {
          return this.request('GET', 'scheduler/tasks', args);
        }
        return this.request('POST', `scheduler/${action}`, args);

      // --- Web ---
      case 'web':
        return this.request('POST', `web/${action}`, args);

      // --- CRM ---
      case 'crm':
        return this.request('POST', `crm/${action}`, args);

      // --- Webhooks ---
      case 'webhooks':
        return this.request('POST', `webhooks/${action}`, args);

      default:
        throw new Error(`Unknown OpenClaw category: ${category}`);
    }
  }

  // ==========================================================================
  // Convenience Methods (typed wrappers for common operations)
  // ==========================================================================

  // --- Tools ---
  async toolsExecute(args: Record<string, unknown>) { return this.dispatch('tools', 'execute', args); }
  async toolsList(args: Record<string, unknown>) { return this.dispatch('tools', 'list', args); }

  // --- Reasoning ---
  async reasoningPlan(args: Record<string, unknown>) { return this.dispatch('reasoning', 'plan', args); }
  async reasoningReflect(args: Record<string, unknown>) { return this.dispatch('reasoning', 'reflect', args); }
  async reasoningDebate(args: Record<string, unknown>) { return this.dispatch('reasoning', 'debate', args); }
  async reasoningConfidence(args: Record<string, unknown>) { return this.dispatch('reasoning', 'confidence', args); }
  async reasoningHallucinationCheck(args: Record<string, unknown>) { return this.dispatch('reasoning', 'hallucination_check', args); }

  // --- NLP ---
  async nlpClassifyIntent(args: Record<string, unknown>) { return this.dispatch('nlp', 'classify_intent', args); }
  async nlpExtractEntities(args: Record<string, unknown>) { return this.dispatch('nlp', 'extract_entities', args); }
  async nlpSentiment(args: Record<string, unknown>) { return this.dispatch('nlp', 'sentiment', args); }
  async nlpTopics(args: Record<string, unknown>) { return this.dispatch('nlp', 'topics', args); }

  // --- Analytics ---
  async analyticsQuery(args: Record<string, unknown>) { return this.dispatch('analytics', 'query', args); }
  async analyticsVisualize(args: Record<string, unknown>) { return this.dispatch('analytics', 'visualize', args); }
  async analyticsAnomalyDetect(args: Record<string, unknown>) { return this.dispatch('analytics', 'anomaly_detect', args); }
  async analyticsForecast(args: Record<string, unknown>) { return this.dispatch('analytics', 'forecast', args); }

  // --- Content ---
  async contentEmailSequences(args: Record<string, unknown>) { return this.dispatch('content', 'email_sequences', args); }
  async contentCopywriting(args: Record<string, unknown>) { return this.dispatch('content', 'copywriting', args); }
  async contentSocialPosts(args: Record<string, unknown>) { return this.dispatch('content', 'social_posts', args); }

  // --- Messaging ---
  async messagingWhatsapp(args: Record<string, unknown>) { return this.dispatch('messaging', 'whatsapp', args); }
  async messagingDiscord(args: Record<string, unknown>) { return this.dispatch('messaging', 'discord', args); }
  async messagingPushNotification(args: Record<string, unknown>) { return this.dispatch('messaging', 'push_notification', args); }

  // --- Security ---
  async securityPiiRedact(args: Record<string, unknown>) { return this.dispatch('security', 'pii_redact', args); }
  async securityModerate(args: Record<string, unknown>) { return this.dispatch('security', 'moderate', args); }
  async securityAuditLog(args: Record<string, unknown>) { return this.dispatch('security', 'audit_log', args); }
  async securityRbacCheck(args: Record<string, unknown>) { return this.dispatch('security', 'rbac_check', args); }

  // --- Documents ---
  async documentsAnalyzeContracts(args: Record<string, unknown>) { return this.dispatch('documents', 'analyze_contracts', args); }
  async documentsParseResumes(args: Record<string, unknown>) { return this.dispatch('documents', 'parse_resumes', args); }
  async documentsProcessInvoices(args: Record<string, unknown>) { return this.dispatch('documents', 'process_invoices', args); }
  async documentsSummarize(args: Record<string, unknown>) { return this.dispatch('documents', 'summarize', args); }

  // --- Growth ---
  async growthScoreLeads(args: Record<string, unknown>) { return this.dispatch('growth', 'score_leads', args); }
  async growthPredictChurn(args: Record<string, unknown>) { return this.dispatch('growth', 'predict_churn', args); }
  async growthOptimizePricing(args: Record<string, unknown>) { return this.dispatch('growth', 'optimize_pricing', args); }
  async growthMonitorCompetitors(args: Record<string, unknown>) { return this.dispatch('growth', 'monitor_competitors', args); }

  // --- Memory ---
  async memoryStore(args: Record<string, unknown>) { return this.dispatch('memory', 'store', args); }
  async memoryRecall(args: Record<string, unknown>) { return this.dispatch('memory', 'recall', args); }
  async memoryForget(args: Record<string, unknown>) { return this.dispatch('memory', 'forget', args); }
  async memorySearchSimilar(args: Record<string, unknown>) { return this.dispatch('memory', 'search_similar', args); }

  // --- Orchestration ---
  async orchestrationSpawnAgents(args: Record<string, unknown>) { return this.dispatch('orchestration', 'spawn_agents', args); }
  async orchestrationManageSkills(args: Record<string, unknown>) { return this.dispatch('orchestration', 'manage_skills', args); }
  async orchestrationHumanInTheLoop(args: Record<string, unknown>) { return this.dispatch('orchestration', 'human_in_the_loop', args); }

  // --- Scheduler ---
  async schedulerAdd(args: Record<string, unknown>) { return this.dispatch('scheduler', 'add', args); }
  async schedulerRemove(args: Record<string, unknown>) { return this.dispatch('scheduler', 'remove', args); }
  async schedulerList(args: Record<string, unknown>) { return this.dispatch('scheduler', 'list', args); }

  // --- Web ---
  async webBrowse(args: Record<string, unknown>) { return this.dispatch('web', 'browse', args); }
  async webScrape(args: Record<string, unknown>) { return this.dispatch('web', 'scrape', args); }

  // --- CRM ---
  async crmOperate(args: Record<string, unknown>) { return this.dispatch('crm', 'operate', args); }

  // --- Webhooks ---
  async webhooksSubscribe(args: Record<string, unknown>) { return this.dispatch('webhooks', 'subscribe', args); }
  async webhooksTrigger(args: Record<string, unknown>) { return this.dispatch('webhooks', 'trigger', args); }
}

// ============================================================================
// Singleton accessor
// ============================================================================

let _instance: OpenClawClient | null = null;

/**
 * Get the singleton OpenClaw client instance.
 * Creates one on first call using env vars for config.
 */
export function getOpenClawClient(logger?: Logger): OpenClawClient {
  if (!_instance) {
    _instance = new OpenClawClient(undefined, logger);
  }
  return _instance;
}

/**
 * Check if OpenClaw is configured (env vars present).
 * Does NOT check if the API is reachable — use client.isAvailable() for that.
 */
export function isOpenClawConfigured(): boolean {
  return !!(process.env.OPENCLAW_API_URL || process.env.OPENCLAW_API_KEY);
}
