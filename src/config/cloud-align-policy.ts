/**
 * Cloud-Align Policy Engine — CLOUD-ALIGN-001
 *
 * Enforces architectural plane/queue/tier/identity separation at runtime.
 * Scoped to the Voice interaction plane. Fails closed on hard violations.
 *
 * Planes:
 *   SWARM = control plane  — decisions, policy, routing
 *   Forge = execution plane — inference, batch compute
 *   Voice = interaction plane — call ingress/egress, CRM, session
 *
 * Rules enforced here:
 *   R1  Plane separation  — Voice node may not process control or forge jobs
 *   R2  Queue separation  — voice.* only; swarm.* / forge.* rejected
 *   R3  Execution tagging — every job must carry execution_tier
 *   R4  Node role         — forbidden capability/role combinations hard-blocked
 *   R5  Identity          — node_id / node_role / environment_id / allowed_capabilities required
 *   R6  Violation         — hard violations block; soft violations logged + reported
 */

import type { Logger } from 'pino';

// ============================================================================
// Types
// ============================================================================

export type NodeRole = 'control' | 'forge' | 'voice';
export type SystemPlane = 'swarm' | 'forge' | 'voice';
export type ViolationSeverity = 'hard' | 'soft';

/** CLOUD-ALIGN-001 §5 — execution tiers (evaluation order: cheapest first) */
export type ExecutionTier =
  | 'factory'          // deterministic, cheapest
  | 'forge_local'      // cheap inference
  | 'forge_premium'    // local high-value
  | 'cloud_fast'       // Groq/Gemini Flash
  | 'cloud_premium';   // Claude/GPT-4o

export const EXECUTION_TIERS: ExecutionTier[] = [
  'factory', 'forge_local', 'forge_premium', 'cloud_fast', 'cloud_premium',
];

/** Node identity — every node/service must declare all four fields */
export interface NodeIdentity {
  node_id: string;
  node_role: NodeRole;
  environment_id: string;        // 'swarm' on Swarm nodes
  allowed_capabilities: string[]; // e.g. ['voice.session.inbound', 'voice.crm.push']
}

/** A job or workload being submitted to this node */
export interface JobRequest {
  job_id?: string;
  queue: string;               // must be prefixed by the correct plane (voice.* for Voice nodes)
  execution_tier?: ExecutionTier;
  source_plane?: SystemPlane;
  capability_required?: string; // e.g. 'voice.session.inbound'
  payload?: Record<string, unknown>;
}

/** A detected policy violation */
export interface PolicyViolation {
  rule: string;
  severity: ViolationSeverity;
  detail: string;
  job_id?: string;
  queue?: string;
  node_role?: NodeRole;
}

/** Result of validating a job against all policy rules */
export interface PolicyDecision {
  allowed: boolean;             // false if any hard violation found
  violations: PolicyViolation[];
  execution_tier: ExecutionTier | null; // resolved tier, or null if missing
}

// ============================================================================
// Queue Plane Prefix Map
// ============================================================================

/** Queue topic prefixes owned by each plane — CLOUD-ALIGN-001 §4 */
const PLANE_QUEUE_PREFIXES: Record<SystemPlane, string[]> = {
  swarm: ['swarm.'],
  forge: ['forge.'],
  voice: ['voice.'],
};

/** Derive plane ownership from a queue name */
function queuePlane(queue: string): SystemPlane | null {
  for (const [plane, prefixes] of Object.entries(PLANE_QUEUE_PREFIXES)) {
    if (prefixes.some(p => queue.startsWith(p))) {
      return plane as SystemPlane;
    }
  }
  return null;
}

// ============================================================================
// Node Role Capability Matrix
// ============================================================================

/**
 * Maps node_role → queue prefixes it is FORBIDDEN to process.
 * Anything not listed is permitted (subject to allowed_capabilities).
 */
const ROLE_FORBIDDEN_QUEUES: Record<NodeRole, SystemPlane[]> = {
  control: ['forge', 'voice'],   // SWARM control nodes may not run forge/voice execution
  forge:   ['swarm'],            // Forge execution nodes may not run control services
  voice:   ['swarm', 'forge'],   // Voice nodes may not run swarm/forge batch jobs
};

// ============================================================================
// Policy Engine
// ============================================================================

export class CloudAlignPolicyEngine {
  private identity: NodeIdentity;
  private logger: Logger;
  private violationLog: PolicyViolation[] = [];

  constructor(identity: NodeIdentity, logger: Logger) {
    this.identity = identity;
    this.logger = logger.child({ component: 'CloudAlignPolicy' });
  }

  // ==========================================================================
  // Primary Validation Entry Point
  // ==========================================================================

  /**
   * Validate a job against all six rules.
   * Hard violations → allowed=false (caller must block).
   * Soft violations → allowed=true but logged + reported.
   */
  validate(job: JobRequest): PolicyDecision {
    const violations: PolicyViolation[] = [];

    // R2: Queue separation
    const jobQueue = job.queue ?? '';
    const jobPlane = queuePlane(jobQueue);

    if (jobPlane === null) {
      violations.push({
        rule: 'R2_QUEUE_SEPARATION',
        severity: 'soft',
        detail: `Queue '${jobQueue}' has no recognised plane prefix (swarm.* | forge.* | voice.*). Tagging required.`,
        job_id: job.job_id,
        queue: jobQueue,
        node_role: this.identity.node_role,
      });
    } else {
      const forbidden = ROLE_FORBIDDEN_QUEUES[this.identity.node_role];
      if (forbidden.includes(jobPlane)) {
        violations.push({
          rule: 'R2_QUEUE_SEPARATION',
          severity: 'hard',
          detail: `Node role '${this.identity.node_role}' may not process ${jobPlane}.* queues. ` +
                  `Received: '${jobQueue}'. Plane separation violated (CLOUD-ALIGN-001 §4).`,
          job_id: job.job_id,
          queue: jobQueue,
          node_role: this.identity.node_role,
        });
      }
    }

    // R1: Plane separation — source plane mismatch
    if (job.source_plane && job.source_plane !== 'voice') {
      const isForgeOverride = job.capability_required &&
        this.identity.allowed_capabilities.includes(job.capability_required);

      if (!isForgeOverride) {
        violations.push({
          rule: 'R1_PLANE_SEPARATION',
          severity: 'hard',
          detail: `Voice node received job originating from '${job.source_plane}' plane. ` +
                  `Cross-plane execution not permitted without explicit capability grant.`,
          job_id: job.job_id,
          queue: jobQueue,
          node_role: this.identity.node_role,
        });
      }
    }

    // R3: Execution tagging
    if (!job.execution_tier) {
      violations.push({
        rule: 'R3_EXECUTION_TIER',
        severity: 'hard',
        detail: `Job '${job.job_id ?? '(unknown)'}' on queue '${jobQueue}' is missing execution_tier. ` +
                `All jobs must declare execution_tier (CLOUD-ALIGN-001 §5).`,
        job_id: job.job_id,
        queue: jobQueue,
        node_role: this.identity.node_role,
      });
    } else if (!EXECUTION_TIERS.includes(job.execution_tier)) {
      violations.push({
        rule: 'R3_EXECUTION_TIER',
        severity: 'hard',
        detail: `Unknown execution_tier '${job.execution_tier}'. Must be one of: ${EXECUTION_TIERS.join(', ')}.`,
        job_id: job.job_id,
        queue: jobQueue,
      });
    }

    // R4: Node role — capability check
    if (job.capability_required &&
        !this.identity.allowed_capabilities.includes(job.capability_required)) {
      violations.push({
        rule: 'R4_NODE_ROLE',
        severity: 'hard',
        detail: `Node '${this.identity.node_id}' (role=${this.identity.node_role}) does not have ` +
                `capability '${job.capability_required}'. Allowed: [${this.identity.allowed_capabilities.join(', ')}].`,
        job_id: job.job_id,
        queue: jobQueue,
        node_role: this.identity.node_role,
      });
    }

    // Log all violations
    for (const v of violations) {
      this.record(v);
    }

    const hardViolations = violations.filter(v => v.severity === 'hard');
    return {
      allowed: hardViolations.length === 0,
      violations,
      execution_tier: job.execution_tier ?? null,
    };
  }

  // ==========================================================================
  // Identity Validation (R5) — called at startup
  // ==========================================================================

  validateIdentity(): PolicyViolation[] {
    const violations: PolicyViolation[] = [];
    const id = this.identity;

    if (!id.node_id) {
      violations.push({ rule: 'R5_IDENTITY', severity: 'hard', detail: 'node_id is missing or empty' });
    }
    if (!id.node_role || !['control', 'forge', 'voice'].includes(id.node_role)) {
      violations.push({ rule: 'R5_IDENTITY', severity: 'hard',
        detail: `node_role '${id.node_role}' is not valid. Must be: control | forge | voice` });
    }
    if (!id.environment_id) {
      violations.push({ rule: 'R5_IDENTITY', severity: 'hard', detail: 'environment_id is missing or empty' });
    }
    if (!id.allowed_capabilities || id.allowed_capabilities.length === 0) {
      violations.push({ rule: 'R5_IDENTITY', severity: 'soft',
        detail: 'allowed_capabilities is empty — node has no declared capabilities' });
    }

    for (const v of violations) {
      this.record(v);
    }

    return violations;
  }

  // ==========================================================================
  // Violation Log
  // ==========================================================================

  private record(v: PolicyViolation): void {
    this.violationLog.push(v);

    const logEntry = {
      rule: v.rule,
      severity: v.severity,
      job_id: v.job_id,
      queue: v.queue,
      node_role: v.node_role ?? this.identity.node_role,
      node_id: this.identity.node_id,
    };

    if (v.severity === 'hard') {
      this.logger.error(logEntry, `CLOUD_ALIGN_HARD_VIOLATION — ${v.detail}`);
    } else {
      this.logger.warn(logEntry, `CLOUD_ALIGN_SOFT_VIOLATION — ${v.detail}`);
    }
  }

  /** Return all recorded violations (for health/telemetry reporting) */
  getViolations(): PolicyViolation[] {
    return [...this.violationLog];
  }

  /** Summarise violations by rule */
  getViolationSummary(): Record<string, { hard: number; soft: number }> {
    const summary: Record<string, { hard: number; soft: number }> = {};
    for (const v of this.violationLog) {
      if (!summary[v.rule]) summary[v.rule] = { hard: 0, soft: 0 };
      summary[v.rule][v.severity]++;
    }
    return summary;
  }

  get nodeIdentity(): NodeIdentity {
    return { ...this.identity };
  }
}

// ============================================================================
// Startup Enforcer — R5 identity + R4 role check at process boot
// ============================================================================

let _policyEngine: CloudAlignPolicyEngine | null = null;

/** Build identity from env vars. Called once at startup. */
export function buildNodeIdentity(): NodeIdentity {
  const raw = process.env.VOICE_ALLOWED_CAPABILITIES ?? '';
  const capabilities = raw
    ? raw.split(',').map(c => c.trim()).filter(Boolean)
    : [
        'voice.session.inbound',
        'voice.session.outbound',
        'voice.stream.telnyx',
        'voice.stream.twilio',
        'voice.crm.push',
        'voice.postprocess',
      ];

  return {
    node_id:              process.env.SWARM_NODE_NAME ?? 'voice-unknown',
    node_role:            (process.env.VOICE_NODE_ROLE as NodeRole) ?? 'voice',
    environment_id:       process.env.SWARM_ENVIRONMENT_ID ?? '',
    allowed_capabilities: capabilities,
  };
}

/** Get the singleton policy engine (initialized by requireCloudAlignPolicy). */
export function getPolicyEngine(): CloudAlignPolicyEngine {
  if (!_policyEngine) throw new Error('CloudAlignPolicyEngine not initialized — call requireCloudAlignPolicy() first');
  return _policyEngine;
}

/**
 * Startup enforcer — validates node identity and role.
 * Hard identity violations → process.exit(1).
 * Soft violations → warn and continue.
 * Returns the initialized engine for use throughout the server.
 */
export function requireCloudAlignPolicy(logger: Logger): CloudAlignPolicyEngine {
  const identity = buildNodeIdentity();
  const engine = new CloudAlignPolicyEngine(identity, logger);
  _policyEngine = engine;

  const violations = engine.validateIdentity();
  const hardViolations = violations.filter(v => v.severity === 'hard');

  if (hardViolations.length > 0) {
    const lines = [
      '╔══════════════════════════════════════════════════════════════╗',
      '║  CLOUD-ALIGN-001 IDENTITY VIOLATION — SERVER WILL NOT START  ║',
      '╠══════════════════════════════════════════════════════════════╣',
      ...hardViolations.map(v => `║  [${v.rule}] ${v.detail.substring(0, 54).padEnd(54)}║`),
      '╠══════════════════════════════════════════════════════════════╣',
      '║  Required env vars (Voice node):                             ║',
      '║    SWARM_NODE_NAME=<node-name>                               ║',
      '║    SWARM_ENVIRONMENT_ID=swarm                                ║',
      '║    VOICE_NODE_ROLE=voice  (default)                          ║',
      '║    VOICE_ALLOWED_CAPABILITIES=<csv>  (has default)           ║',
      '╚══════════════════════════════════════════════════════════════╝',
    ].join('\n');

    logger.fatal({ violations: hardViolations }, 'CLOUD_ALIGN_IDENTITY_FAIL');
    console.error('\n' + lines + '\n');
    process.exit(1);
  }

  logger.info({
    node_id:              identity.node_id,
    node_role:            identity.node_role,
    environment_id:       identity.environment_id,
    allowed_capabilities: identity.allowed_capabilities,
    soft_violations:      violations.filter(v => v.severity === 'soft').length,
  }, 'CLOUD_ALIGN_OK — node identity and role validated');

  return engine;
}
