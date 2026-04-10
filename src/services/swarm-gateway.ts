/**
 * Swarm Gateway Client — Full Access to the Swarm Mainframe Ecosystem
 *
 * Provides Jack, Jenny, and other voice agents with direct access to:
 *   - 23+ agent castes (DRONE, HYDRA, MUTALISK, ULTRA, GUARDIAN, etc.)
 *   - 26 external AI models via AI Portal bridge
 *   - Triton GPU inference (40+ ternary models)
 *   - Calculus Mortgage Growth Engine
 *   - Calculus Code Engine
 *   - Specialist APIs: marketing, analytics, billing, deployment, etc.
 *
 * Connection: swarm-mainframe (SWARM_MAINFRAME_URL) with JWT auth (SWARM_API_KEY)
 * Pattern: Singleton with availability check and graceful degradation
 */

import type { Logger } from 'pino';

// ============================================================================
// Types
// ============================================================================

export type AgentCaste =
  | 'DRONE_ULTRA_CHEAP' | 'DRONE_CHEAP' | 'DRONE_FAST'
  | 'HYDRA_FINANCIAL' | 'HYDRA_COMPLIANCE' | 'HYDRA_CODE' | 'HYDRA_MARKETING'
  | 'MUTALISK_LEGAL' | 'MUTALISK_QUICK' | 'MUTALISK_CONVERSATIONAL'
  | 'ULTRA_REASONING' | 'ULTRA_RESEARCH'
  | 'GUARDIAN_CLAUDE' | 'GUARDIAN_OPUS'
  | 'OVERSEER' | 'CHANGELING' | 'NYDUS'
  | 'TERNARY_CODER'
  | 'CCE_ROUTER' | 'CCE_PATCHER' | 'CCE_GENERATOR' | 'CCE_TESTER' | 'CCE_REVIEWER';

export interface SwarmTask {
  description: string;
  caste?: AgentCaste | string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  context?: Record<string, unknown>;
  callback_url?: string;
}

export interface SwarmTaskResult {
  task_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  created_at?: string;
  completed_at?: string;
}

export interface SwarmModel {
  id: string;
  name: string;
  provider: string;
  capabilities?: string[];
}

export interface SwarmSkill {
  id: string;
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface AIQueryOptions {
  system_prompt?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface SwarmHealthStatus {
  status: string;
  uptime?: number;
  agents_active?: number;
  tasks_queued?: number;
  models_available?: number;
}

// ============================================================================
// Configuration
// ============================================================================

export interface SwarmGatewayConfig {
  /** Base URL for the swarm mainframe (default: http://34.148.140.31:8080) */
  baseUrl: string;
  /** JWT API key for authentication */
  apiKey?: string;
  /** Request timeout in ms (default: 30000) */
  timeoutMs: number;
}

const DEFAULT_CONFIG: SwarmGatewayConfig = {
  baseUrl: process.env.SWARM_MAINFRAME_URL ?? 'http://34.148.140.31:8080',
  apiKey: process.env.SWARM_API_KEY,
  timeoutMs: 30_000,
};

const API_PREFIX = '/api/v1';

// ============================================================================
// Singleton
// ============================================================================

let _instance: SwarmGatewayClient | null = null;

export function isSwarmConfigured(): boolean {
  return !!(process.env.SWARM_MAINFRAME_URL || process.env.SWARM_API_KEY);
}

export function getSwarmGateway(logger?: Logger): SwarmGatewayClient {
  if (!_instance) {
    _instance = new SwarmGatewayClient(undefined, logger);
  }
  return _instance;
}

// ============================================================================
// Swarm Gateway Client
// ============================================================================

export class SwarmGatewayClient {
  private config: SwarmGatewayConfig;
  private logger: Logger | undefined;
  private _available: boolean | null = null;

  /** Specialist API namespaces */
  readonly calculus: CalculusNamespace;
  readonly marketing: MarketingNamespace;
  readonly analytics: AnalyticsNamespace;

  constructor(config?: Partial<SwarmGatewayConfig>, logger?: Logger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger?.child({ component: 'SwarmGateway' });

    // Ensure no trailing slash on baseUrl
    this.config.baseUrl = this.config.baseUrl.replace(/\/+$/, '');

    // Initialize specialist namespaces
    this.calculus = new CalculusNamespace(this);
    this.marketing = new MarketingNamespace(this);
    this.analytics = new AnalyticsNamespace(this);
  }

  // ==========================================================================
  // Availability
  // ==========================================================================

  /** Check if the swarm mainframe is reachable */
  async checkAvailability(): Promise<boolean> {
    try {
      const res = await this.request('GET', '/safety/status', undefined, 5_000);
      this._available = res.ok;
      return this._available;
    } catch {
      this._available = false;
      this.logger?.warn('Swarm mainframe is not reachable');
      return false;
    }
  }

  get available(): boolean | null {
    return this._available;
  }

  // ==========================================================================
  // Core Methods
  // ==========================================================================

  /** Submit a task to any agent caste */
  async submitTask(task: SwarmTask): Promise<SwarmTaskResult> {
    return this.post('/tasks', task);
  }

  /** Query any of the 26 AI models directly */
  async queryAI(model: string, prompt: string, options?: AIQueryOptions): Promise<unknown> {
    return this.post('/tasks', {
      description: prompt,
      model,
      system_prompt: options?.system_prompt,
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      stream: options?.stream ?? false,
    });
  }

  /** Get available models */
  async listModels(): Promise<SwarmModel[]> {
    return this.get('/models');
  }

  /** Get full model catalog with capabilities */
  async getModelCatalog(): Promise<unknown> {
    return this.get('/models/catalog');
  }

  /** List available swarm skills */
  async listSkills(): Promise<SwarmSkill[]> {
    return this.get('/skills');
  }

  /** Invoke a specific skill */
  async invokeSkill(skillId: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.post(`/skills/${encodeURIComponent(skillId)}/invoke`, params ?? {});
  }

  /** Check task progress */
  async getTaskStatus(taskId: string): Promise<SwarmTaskResult> {
    return this.get(`/tasks/${encodeURIComponent(taskId)}`);
  }

  /** System health check */
  async getSwarmHealth(): Promise<SwarmHealthStatus> {
    return this.get('/safety/status');
  }

  /** GPU/Triton inference status */
  async getTritonStatus(): Promise<unknown> {
    return this.get('/triton');
  }

  /** Request a specific specialist AI by caste */
  async requestSpecialist(caste: string, task: string, context?: Record<string, unknown>): Promise<unknown> {
    return this.post('/tasks', {
      description: task,
      caste,
      context,
      priority: 'high',
    });
  }

  // ==========================================================================
  // Unified Dispatch (for tool-executor routing)
  // ==========================================================================

  /**
   * Route swarm tool calls from the tool executor.
   * Tool names follow the pattern: swarm_<action>
   */
  async dispatch(action: string, args: Record<string, unknown>): Promise<unknown> {
    switch (action) {
      case 'submit_task':
        return this.submitTask({
          description: args.description as string,
          caste: args.caste as string | undefined,
          priority: args.priority as SwarmTask['priority'],
          context: args.context as Record<string, unknown> | undefined,
        });

      case 'query_ai':
        return this.queryAI(
          args.model as string,
          args.prompt as string,
          {
            system_prompt: args.system_prompt as string | undefined,
            temperature: args.temperature as number | undefined,
            max_tokens: args.max_tokens as number | undefined,
          },
        );

      case 'list_models':
        return this.listModels();

      case 'request_specialist':
        return this.requestSpecialist(
          args.caste as string,
          args.task as string,
          args.context as Record<string, unknown> | undefined,
        );

      case 'invoke_skill':
        return this.invokeSkill(
          args.skill_id as string,
          args.params as Record<string, unknown> | undefined,
        );

      case 'task_status':
        return this.getTaskStatus(args.task_id as string);

      case 'health':
        return this.getSwarmHealth();

      case 'calculus_mortgage':
        return this.calculus.mortgageAnalysis(args.action as string, args.data as Record<string, unknown>);

      case 'calculus_code':
        return this.calculus.codeGenerate(args.action as string, args.spec as Record<string, unknown>);

      case 'marketing':
        return this.marketing.createCampaign(args.action as string, args.data as Record<string, unknown>);

      case 'analytics':
        return this.analytics.query(args.query as string, args.type as string | undefined);

      default:
        throw new Error(`Unknown swarm action: ${action}`);
    }
  }

  // ==========================================================================
  // HTTP Layer
  // ==========================================================================

  /** Internal GET request */
  async get<T = unknown>(path: string): Promise<T> {
    const res = await this.request('GET', path);
    return res.json() as Promise<T>;
  }

  /** Internal POST request */
  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await this.request('POST', path, body);
    return res.json() as Promise<T>;
  }

  /** Low-level request with auth, timeout, and error handling */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    timeoutOverride?: number,
  ): Promise<Response> {
    const url = `${this.config.baseUrl}${API_PREFIX}${path}`;
    const timeout = timeoutOverride ?? this.config.timeoutMs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };

      if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }

      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => 'unknown');
        this.logger?.error({ status: res.status, url, errorBody }, 'Swarm request failed');
        throw new Error(`Swarm API error ${res.status}: ${errorBody}`);
      }

      return res;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        this.logger?.error({ url, timeout }, 'Swarm request timed out');
        throw new Error(`Swarm request timed out after ${timeout}ms: ${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ============================================================================
// Specialist Namespaces
// ============================================================================

class CalculusNamespace {
  constructor(private client: SwarmGatewayClient) {}

  /** Calculus Mortgage Growth Engine */
  async mortgageAnalysis(action: string, data: Record<string, unknown>): Promise<unknown> {
    return this.client.post('/calculus_mortgage_growth/' + encodeURIComponent(action), data);
  }

  /** Calculus Code Engine */
  async codeGenerate(action: string, spec: Record<string, unknown>): Promise<unknown> {
    return this.client.post('/calculus_code_engine/' + encodeURIComponent(action), spec);
  }
}

class MarketingNamespace {
  constructor(private client: SwarmGatewayClient) {}

  /** Marketing swarm operations */
  async createCampaign(action: string, data: Record<string, unknown>): Promise<unknown> {
    return this.client.post('/marketing/' + encodeURIComponent(action), data);
  }
}

class AnalyticsNamespace {
  constructor(private client: SwarmGatewayClient) {}

  /** Analytics engine queries */
  async query(query: string, type?: string): Promise<unknown> {
    return this.client.post('/analytics/query', { query, type });
  }
}
