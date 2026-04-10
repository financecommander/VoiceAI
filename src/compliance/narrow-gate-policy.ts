/**
 * Narrow Compliance Gate Policy
 *
 * Enforces two structural rules on how enforcement methods may be applied
 * across content types and task categories. Report-only — no hard blocking.
 *
 * Rule 1 — Literal-pattern pre-reject scope:
 *   literal_pattern pre-reject gates are permitted ONLY on content_type='email'.
 *   Any other content_type using literal_pattern at the pre-reject phase is a violation.
 *
 * Rule 2 — BinaryNet enforcement exclusion list:
 *   BinaryNet (binary classifier enforcement) must NOT be used on any of these
 *   task categories. BinaryNet is designed for binary signal detection; applying it
 *   to these categories produces unreliable enforcement with high false-positive risk.
 *
 *   Blocked categories:
 *     swarm_control, coding, lead, planning, forge_orchestration,
 *     client_management, multimodal, sec, retrieval, verification
 *
 * Both rules emit violations as structured log entries only.
 * No call, job, or response is blocked by this module.
 */

import type { Logger } from 'pino';

// ============================================================================
// Types
// ============================================================================

/** Enforcement methods that may be applied at compliance gates */
export type EnforcementMethod =
  | 'literal_pattern'   // regex/keyword pre-reject
  | 'binarynet'         // BinaryNet binary classifier (security_monitor_net etc.)
  | 'llm'               // LLM-based evaluation
  | 'ternary'           // ternary model classifier
  | 'rules_engine'      // deterministic rules
  | 'human_review';     // escalated to human

/** Phase at which the gate fires */
export type GatePhase = 'pre_reject' | 'runtime' | 'post_call';

/** Content type being evaluated */
export type ContentType =
  | 'email'
  | 'sms'
  | 'voice'
  | 'document'
  | 'api_payload'
  | 'structured_data'
  | 'code'
  | 'image'
  | 'multimodal';

/** Task category the enforcement is being applied to */
export type TaskCategory =
  | 'swarm_control'
  | 'coding'
  | 'lead'
  | 'planning'
  | 'forge_orchestration'
  | 'client_management'
  | 'multimodal'
  | 'sec'
  | 'retrieval'
  | 'verification'
  | string; // extensible for future categories

/** Input to the policy check */
export interface NarrowGatePolicyInput {
  /** The enforcement method being applied */
  enforcement_method: EnforcementMethod | string;
  /** The gate phase (pre_reject required for Rule 1) */
  gate_phase: GatePhase;
  /** The content type being evaluated */
  content_type: ContentType | string;
  /** The task category the enforcement applies to */
  task_category: TaskCategory;
  /** Optional correlation context for the violation report */
  context?: {
    job_id?: string;
    conversation_id?: string;
    node_id?: string;
    gate_id?: string;
  };
}

/** A policy violation — report-only, no blocking action */
export interface NarrowGatePolicyViolation {
  rule: 'R1_LITERAL_PATTERN_SCOPE' | 'R2_BINARYNET_EXCLUSION';
  detail: string;
  enforcement_method: string;
  gate_phase: GatePhase;
  content_type: string;
  task_category: string;
  context: NarrowGatePolicyInput['context'];
  timestamp: string;
}

export interface NarrowGatePolicyResult {
  violations: NarrowGatePolicyViolation[];
  /** Always true — this policy reports only, never blocks */
  allowed: true;
}

// ============================================================================
// Policy Constants
// ============================================================================

/**
 * Rule 2 — BinaryNet is excluded from these task categories.
 * Rationale: BinaryNet produces binary signal (pass/fail) which is too coarse
 * for semantic task categories requiring nuanced multi-class reasoning.
 */
export const BINARYNET_EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set([
  'swarm_control',
  'coding',
  'lead',
  'planning',
  'forge_orchestration',
  'client_management',
  'multimodal',
  'sec',
  'retrieval',
  'verification',
]);

/**
 * Rule 1 — Literal-pattern pre-reject is only permitted on email.
 * All other content types must use a semantic/model-based method.
 */
export const LITERAL_PATTERN_PERMITTED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'email',
]);

// ============================================================================
// Policy Engine
// ============================================================================

export class NarrowGatePolicyEngine {
  private logger: Logger;
  private violationLog: NarrowGatePolicyViolation[] = [];

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'NarrowGatePolicy' });
  }

  /**
   * Evaluate a gate application against narrow gate policy rules.
   * Always returns allowed=true — violations are reported, never blocking.
   */
  check(input: NarrowGatePolicyInput): NarrowGatePolicyResult {
    const violations: NarrowGatePolicyViolation[] = [];
    const ts = new Date().toISOString();

    // Rule 1: literal_pattern pre-reject only permitted on email
    if (
      input.enforcement_method === 'literal_pattern' &&
      input.gate_phase === 'pre_reject' &&
      !LITERAL_PATTERN_PERMITTED_CONTENT_TYPES.has(input.content_type)
    ) {
      violations.push({
        rule: 'R1_LITERAL_PATTERN_SCOPE',
        detail:
          `literal_pattern pre-reject applied to content_type='${input.content_type}'. ` +
          `Permitted only on: [${[...LITERAL_PATTERN_PERMITTED_CONTENT_TYPES].join(', ')}]. ` +
          `Use a semantic enforcement method for this content type.`,
        enforcement_method: input.enforcement_method,
        gate_phase: input.gate_phase,
        content_type: input.content_type,
        task_category: input.task_category,
        context: input.context,
        timestamp: ts,
      });
    }

    // Rule 2: BinaryNet excluded from specific task categories
    if (
      input.enforcement_method === 'binarynet' &&
      BINARYNET_EXCLUDED_CATEGORIES.has(input.task_category)
    ) {
      violations.push({
        rule: 'R2_BINARYNET_EXCLUSION',
        detail:
          `BinaryNet enforcement applied to task_category='${input.task_category}'. ` +
          `BinaryNet is excluded from: [${[...BINARYNET_EXCLUDED_CATEGORIES].join(', ')}]. ` +
          `Use ternary, llm, or rules_engine for this category.`,
        enforcement_method: input.enforcement_method,
        gate_phase: input.gate_phase,
        content_type: input.content_type,
        task_category: input.task_category,
        context: input.context,
        timestamp: ts,
      });
    }

    // Report all violations
    for (const v of violations) {
      this.report(v);
    }

    return { violations, allowed: true };
  }

  private report(v: NarrowGatePolicyViolation): void {
    this.violationLog.push(v);
    this.logger.warn(
      {
        rule: v.rule,
        enforcement_method: v.enforcement_method,
        gate_phase: v.gate_phase,
        content_type: v.content_type,
        task_category: v.task_category,
        ...v.context,
      },
      `NARROW_GATE_VIOLATION — ${v.detail}`,
    );
  }

  /** All violations recorded since instantiation */
  getViolations(): NarrowGatePolicyViolation[] {
    return [...this.violationLog];
  }

  /** Counts by rule */
  getSummary(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const v of this.violationLog) {
      counts[v.rule] = (counts[v.rule] ?? 0) + 1;
    }
    return counts;
  }
}

// ============================================================================
// Singleton accessor
// ============================================================================

let _engine: NarrowGatePolicyEngine | null = null;

export function getNarrowGatePolicyEngine(logger?: Logger): NarrowGatePolicyEngine {
  if (!_engine) {
    if (!logger) throw new Error('NarrowGatePolicyEngine: logger required on first call');
    _engine = new NarrowGatePolicyEngine(logger);
  }
  return _engine;
}

/**
 * Convenience wrapper — check a gate application and return violations.
 * Initialises the engine on first use.
 */
export function checkNarrowGatePolicy(
  input: NarrowGatePolicyInput,
  logger?: Logger,
): NarrowGatePolicyResult {
  return getNarrowGatePolicyEngine(logger).check(input);
}
