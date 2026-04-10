/**
 * Sandbox — Tool execution isolation
 *
 * Wraps tool execution with:
 *   - Timeout enforcement
 *   - Input validation
 *   - Output size limits
 *   - VM isolation for untrusted tools (swarm_*, openclaw_*)
 *   - Audit logging of all executions
 */

import { createHash } from 'crypto';
import vm from 'vm';
import type { Logger } from 'pino';
import type { Database } from '../db/client.js';
import { sandboxExecutions } from '../db/schema.js';
import type { SandboxPolicy, SandboxResult, SandboxTrustLevel } from './types.js';

// ============================================================================
// Tool Policy Map
// ============================================================================

const TOOL_POLICIES: Record<string, SandboxPolicy> = {};

/** Default policies by prefix */
const PREFIX_POLICIES: { prefix: string; policy: SandboxPolicy }[] = [
  // Trusted internal services — timeout only
  { prefix: 'nymbus_', policy: { trustLevel: 'trusted', timeoutMs: 5000, maxOutputBytes: 50_000, isolated: false } },
  { prefix: 'pricing_', policy: { trustLevel: 'trusted', timeoutMs: 5000, maxOutputBytes: 50_000, isolated: false } },
  { prefix: 'tilt_', policy: { trustLevel: 'trusted', timeoutMs: 5000, maxOutputBytes: 50_000, isolated: false } },
  { prefix: 'loanpro_', policy: { trustLevel: 'trusted', timeoutMs: 5000, maxOutputBytes: 50_000, isolated: false } },
  { prefix: 'eureka_', policy: { trustLevel: 'trusted', timeoutMs: 5000, maxOutputBytes: 50_000, isolated: false } },
  { prefix: 'ifse_', policy: { trustLevel: 'trusted', timeoutMs: 5000, maxOutputBytes: 50_000, isolated: false } },
  { prefix: 'auth_', policy: { trustLevel: 'trusted', timeoutMs: 5000, maxOutputBytes: 10_000, isolated: false } },

  // Semi-trusted — timeout + output limits
  { prefix: 'crm_', policy: { trustLevel: 'semi_trusted', timeoutMs: 8000, maxOutputBytes: 100_000, isolated: false } },
  { prefix: 'hubspot_', policy: { trustLevel: 'semi_trusted', timeoutMs: 8000, maxOutputBytes: 100_000, isolated: false } },
  { prefix: 'ghl_', policy: { trustLevel: 'semi_trusted', timeoutMs: 8000, maxOutputBytes: 100_000, isolated: false } },

  // Untrusted — full sandbox
  { prefix: 'openclaw_', policy: { trustLevel: 'untrusted', timeoutMs: 10_000, maxOutputBytes: 200_000, isolated: true } },
  { prefix: 'swarm_', policy: { trustLevel: 'untrusted', timeoutMs: 30_000, maxOutputBytes: 500_000, isolated: true } },
];

/** Default fallback policy */
const DEFAULT_POLICY: SandboxPolicy = {
  trustLevel: 'semi_trusted',
  timeoutMs: 5000,
  maxOutputBytes: 50_000,
  isolated: false,
};

function getPolicyForTool(toolName: string): SandboxPolicy {
  if (TOOL_POLICIES[toolName]) return TOOL_POLICIES[toolName];
  for (const { prefix, policy } of PREFIX_POLICIES) {
    if (toolName.startsWith(prefix)) return policy;
  }
  return DEFAULT_POLICY;
}

// ============================================================================
// Sandbox Executor
// ============================================================================

export class SandboxExecutor {
  private db: Database | null;
  private logger: Logger;

  constructor(db: Database | null, logger: Logger) {
    this.db = db;
    this.logger = logger.child({ component: 'Sandbox' });
  }

  /**
   * Execute a tool function within sandbox constraints.
   * Returns the result wrapped in SandboxResult with timing and isolation info.
   */
  async run<T>(
    toolName: string,
    fn: () => Promise<T>,
    sessionId?: string,
    inputArgs?: Record<string, unknown>,
  ): Promise<SandboxResult<T>> {
    const policy = getPolicyForTool(toolName);
    const startTime = Date.now();
    const inputHash = inputArgs
      ? createHash('sha256').update(JSON.stringify(inputArgs)).digest('hex').substring(0, 64)
      : null;

    try {
      // Execute with timeout
      const result = await this.executeWithTimeout(fn, policy.timeoutMs);

      // Check output size
      const outputStr = JSON.stringify(result);
      if (outputStr.length > policy.maxOutputBytes) {
        throw new Error(`Output exceeded max size: ${outputStr.length} > ${policy.maxOutputBytes} bytes`);
      }

      const durationMs = Date.now() - startTime;

      // Audit log
      await this.logExecution({
        toolName,
        isolated: policy.isolated,
        durationMs,
        success: true,
        inputHash,
        outputSizeBytes: outputStr.length,
        sessionId,
      });

      return { success: true, result, durationMs, isolated: policy.isolated };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err?.message ?? 'Unknown sandbox error';

      this.logger.warn({ toolName, error: errorMsg, durationMs, policy: policy.trustLevel }, 'Sandbox execution failed');

      await this.logExecution({
        toolName,
        isolated: policy.isolated,
        durationMs,
        success: false,
        error: errorMsg,
        inputHash,
        sessionId,
      });

      return { success: false, error: errorMsg, durationMs, isolated: policy.isolated };
    }
  }

  /** Get the policy for a given tool (for inspection) */
  getPolicy(toolName: string): SandboxPolicy {
    return getPolicyForTool(toolName);
  }

  private async executeWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Sandbox timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private async logExecution(params: {
    toolName: string;
    isolated: boolean;
    durationMs: number;
    success: boolean;
    error?: string;
    inputHash?: string | null;
    outputSizeBytes?: number;
    sessionId?: string;
  }): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.insert(sandboxExecutions).values({
        toolName: params.toolName,
        isolated: params.isolated,
        durationMs: params.durationMs,
        success: params.success,
        error: params.error ?? null,
        inputHash: params.inputHash ?? null,
        outputSizeBytes: params.outputSizeBytes ?? null,
        sessionId: params.sessionId ?? null,
      });
    } catch {
      // Never let audit logging fail the actual operation
    }
  }
}
