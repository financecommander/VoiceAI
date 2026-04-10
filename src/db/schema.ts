/**
 * Drizzle ORM Schema — Voice Agent Database
 *
 * Tables:
 *   voice_sessions      — Active/completed call sessions
 *   audit_events        — Compliance audit trail (immutable append-only)
 *   consent_records     — TCPA consent tracking per phone number
 *   auth_sessions       — OTP verification state per call
 *   otp_attempts        — Rate limiting + audit of OTP attempts
 *   conversation_turns  — LLM conversation history for session replay
 *
 * Database: PostgreSQL 15+
 * ORM: Drizzle (type-safe, zero-overhead)
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  pgEnum,
  index,
  real,
  primaryKey,
  foreignKey,
  unique,
} from 'drizzle-orm/pg-core';

// ============================================================================
// Enums
// ============================================================================

export const calcModelEnum = pgEnum('calc_model', [
  'DMC', 'CONSTITUTIONAL_TENDER', 'TILT', 'MORTGAGE', 'REAL_ESTATE', 'EUREKA', 'LOAN_SERVICING', 'IFSE',
]);

export const callDirectionEnum = pgEnum('call_direction', ['inbound', 'outbound']);

export const callStatusEnum = pgEnum('call_status', [
  'ringing', 'in_progress', 'completed', 'failed', 'blocked', 'transferred',
]);

export const pipelineModeEnum = pgEnum('pipeline_mode', ['modular', 'speech_to_speech']);

export const authTierEnum = pgEnum('auth_tier', ['0', '1', '2', '3']);

export const consentTypeEnum = pgEnum('consent_type', [
  'express_written', 'express_oral', 'implied', 'prior_business',
]);

export const consentStatusEnum = pgEnum('consent_status', ['active', 'revoked', 'expired']);

export const auditEventTypeEnum = pgEnum('audit_event_type', [
  'call_started', 'call_ended', 'auth_upgraded', 'auth_failed',
  'consent_captured', 'consent_revoked', 'disclosure_delivered',
  'opt_out_detected', 'pii_detected', 'pii_blocked',
  'tool_executed', 'tool_error', 'escalation_triggered',
  'compliance_gate_passed', 'compliance_gate_failed',
  'pipeline_switched', 'recording_started', 'recording_stopped',
  // Operator hardening events
  'operator_login', 'operator_action', 'operator_logout',
  'approval_requested', 'approval_granted', 'approval_rejected',
  'sandbox_violation', 'sandbox_timeout',
  'drill_started', 'drill_completed',
  'session_force_killed', 'config_changed',
  'portal_connected', 'portal_command',
]);

export const turnRoleEnum = pgEnum('turn_role', ['user', 'assistant', 'system', 'tool']);

export const operatorRoleEnum = pgEnum('operator_role', [
  'superadmin', 'operator', 'viewer', 'portal_service',
]);

export const approvalStatusEnum = pgEnum('approval_status', [
  'pending', 'approved', 'rejected', 'expired', 'auto_approved',
]);

export const drillStatusEnum = pgEnum('drill_status', [
  'running', 'passed', 'failed', 'aborted',
]);

// ============================================================================
// Voice Sessions
// ============================================================================

export const voiceSessions = pgTable('voice_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  callSid: varchar('call_sid', { length: 64 }).notNull().unique(),
  streamSid: varchar('stream_sid', { length: 64 }),

  model: calcModelEnum('model').notNull(),
  direction: callDirectionEnum('direction').notNull(),
  status: callStatusEnum('status').notNull().default('ringing'),
  pipelineMode: pipelineModeEnum('pipeline_mode').notNull().default('modular'),

  callerPhone: varchar('caller_phone', { length: 20 }).notNull(),
  calledPhone: varchar('called_phone', { length: 20 }).notNull(),
  callerState: varchar('caller_state', { length: 2 }),

  customerId: varchar('customer_id', { length: 64 }),
  authTier: authTierEnum('auth_tier').notNull().default('0'),

  llmProvider: varchar('llm_provider', { length: 20 }),
  totalTurns: integer('total_turns').notNull().default(0),
  totalToolCalls: integer('total_tool_calls').notNull().default(0),
  totalTokensUsed: integer('total_tokens_used').notNull().default(0),

  complianceScore: real('compliance_score'),
  complianceGatesPassed: integer('compliance_gates_passed').default(0),
  complianceGatesFailed: integer('compliance_gates_failed').default(0),

  durationMs: integer('duration_ms'),
  recordingUrl: text('recording_url'),
  transferredTo: varchar('transferred_to', { length: 64 }),
  endReason: varchar('end_reason', { length: 64 }),

  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  callSidIdx: index('idx_sessions_call_sid').on(table.callSid),
  callerPhoneIdx: index('idx_sessions_caller_phone').on(table.callerPhone),
  modelIdx: index('idx_sessions_model').on(table.model),
  statusIdx: index('idx_sessions_status').on(table.status),
  startedAtIdx: index('idx_sessions_started_at').on(table.startedAt),
  customerIdx: index('idx_sessions_customer').on(table.customerId),
}));

// ============================================================================
// Audit Events (Append-Only Compliance Log)
// ============================================================================

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').references(() => voiceSessions.id),
  conversationId: varchar('conversation_id', { length: 64 }).notNull(),

  eventType: auditEventTypeEnum('event_type').notNull(),
  model: calcModelEnum('model').notNull(),
  authTier: authTierEnum('auth_tier').notNull(),

  customerId: varchar('customer_id', { length: 64 }),
  intent: varchar('intent', { length: 64 }),
  action: varchar('action', { length: 128 }),
  result: text('result'),

  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdByAgent: boolean('created_by_agent').notNull().default(true),

  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sessionIdx: index('idx_audit_session').on(table.sessionId),
  conversationIdx: index('idx_audit_conversation').on(table.conversationId),
  eventTypeIdx: index('idx_audit_event_type').on(table.eventType),
  timestampIdx: index('idx_audit_timestamp').on(table.timestamp),
  customerIdx: index('idx_audit_customer').on(table.customerId),
}));

// ============================================================================
// Consent Records (TCPA Compliance)
// ============================================================================

export const consentRecords = pgTable('consent_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: varchar('phone', { length: 20 }).notNull(),
  customerId: varchar('customer_id', { length: 64 }),
  model: calcModelEnum('model').notNull(),

  consentType: consentTypeEnum('consent_type').notNull(),
  status: consentStatusEnum('status').notNull().default('active'),
  scope: varchar('scope', { length: 64 }).notNull().default('voice_ai'),

  capturedVia: varchar('captured_via', { length: 32 }).notNull(),
  capturedConversationId: varchar('captured_conversation_id', { length: 64 }),
  capturedByAgent: boolean('captured_by_agent').notNull().default(false),

  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedVia: varchar('revoked_via', { length: 32 }),
  revokedConversationId: varchar('revoked_conversation_id', { length: 64 }),

  expiresAt: timestamp('expires_at', { withTimezone: true }),

  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  phoneIdx: index('idx_consent_phone').on(table.phone),
  phoneModelIdx: index('idx_consent_phone_model').on(table.phone, table.model),
  statusIdx: index('idx_consent_status').on(table.status),
  customerIdx: index('idx_consent_customer').on(table.customerId),
}));

// ============================================================================
// Auth Sessions (OTP Verification State)
// ============================================================================

export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').references(() => voiceSessions.id).notNull(),

  phone: varchar('phone', { length: 20 }).notNull(),
  customerId: varchar('customer_id', { length: 64 }),

  currentTier: authTierEnum('current_tier').notNull().default('0'),
  targetTier: authTierEnum('target_tier'),

  otpCode: varchar('otp_code', { length: 8 }),
  otpExpiresAt: timestamp('otp_expires_at', { withTimezone: true }),
  otpAttempts: integer('otp_attempts').notNull().default(0),
  otpMaxAttempts: integer('otp_max_attempts').notNull().default(3),

  phoneVerified: boolean('phone_verified').notNull().default(false),
  securityQuestionsVerified: boolean('security_questions_verified').notNull().default(false),
  otpVerified: boolean('otp_verified').notNull().default(false),
  livenessVerified: boolean('liveness_verified').notNull().default(false),

  lockedUntil: timestamp('locked_until', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sessionIdx: index('idx_auth_session').on(table.sessionId),
  phoneIdx: index('idx_auth_phone').on(table.phone),
}));

// ============================================================================
// OTP Attempts (Rate Limiting + Audit)
// ============================================================================

export const otpAttempts = pgTable('otp_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  authSessionId: uuid('auth_session_id').references(() => authSessions.id).notNull(),
  phone: varchar('phone', { length: 20 }).notNull(),

  codeEntered: varchar('code_entered', { length: 8 }).notNull(),
  correct: boolean('correct').notNull(),
  attemptNumber: integer('attempt_number').notNull(),

  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: varchar('user_agent', { length: 256 }),

  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  authSessionIdx: index('idx_otp_auth_session').on(table.authSessionId),
  phoneIdx: index('idx_otp_phone').on(table.phone),
  timestampIdx: index('idx_otp_timestamp').on(table.timestamp),
}));

// ============================================================================
// Conversation Turns (LLM History for Replay/Audit)
// ============================================================================

export const conversationTurns = pgTable('conversation_turns', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').references(() => voiceSessions.id).notNull(),
  conversationId: varchar('conversation_id', { length: 64 }).notNull(),

  turnNumber: integer('turn_number').notNull(),
  role: turnRoleEnum('role').notNull(),
  content: text('content').notNull(),

  llmProvider: varchar('llm_provider', { length: 20 }),
  intent: varchar('intent', { length: 64 }),
  toolName: varchar('tool_name', { length: 128 }),
  toolCallId: varchar('tool_call_id', { length: 64 }),

  tokensUsed: integer('tokens_used'),
  latencyMs: integer('latency_ms'),
  wasFallback: boolean('was_fallback').default(false),

  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sessionIdx: index('idx_turns_session').on(table.sessionId),
  conversationIdx: index('idx_turns_conversation').on(table.conversationId),
  turnNumberIdx: index('idx_turns_number').on(table.sessionId, table.turnNumber),
}));

// ============================================================================
// DNC Suppression List
// ============================================================================

// ============================================================================
// Operator Users (Dashboard / Portal Auth)
// ============================================================================

export const operatorUsers = pgTable('operator_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  name: varchar('name', { length: 128 }).notNull(),
  role: operatorRoleEnum('role').notNull().default('viewer'),

  isActive: boolean('is_active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  emailIdx: index('idx_operator_email').on(table.email),
}));

// ============================================================================
// Operator Sessions (JWT Tracking)
// ============================================================================

export const operatorSessions = pgTable('operator_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => operatorUsers.id).notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  revoked: boolean('revoked').notNull().default(false),

  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdx: index('idx_op_sessions_user').on(table.userId),
  tokenIdx: index('idx_op_sessions_token').on(table.tokenHash),
}));

// ============================================================================
// Approval Requests (Sensitive Action Workflow)
// ============================================================================

export const approvalRequests = pgTable('approval_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  actionType: varchar('action_type', { length: 128 }).notNull(),
  description: text('description').notNull(),

  requestedBy: uuid('requested_by').references(() => operatorUsers.id),
  requestedByAgent: varchar('requested_by_agent', { length: 64 }),

  status: approvalStatusEnum('status').notNull().default('pending'),
  approvedBy: uuid('approved_by').references(() => operatorUsers.id),

  context: jsonb('context').$type<Record<string, unknown>>(),
  result: text('result'),

  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (table) => ({
  statusIdx: index('idx_approvals_status').on(table.status),
  requestedAtIdx: index('idx_approvals_requested_at').on(table.requestedAt),
}));

// ============================================================================
// Sandbox Executions (Tool Isolation Audit)
// ============================================================================

export const sandboxExecutions = pgTable('sandbox_executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  toolName: varchar('tool_name', { length: 128 }).notNull(),
  isolated: boolean('isolated').notNull(),
  durationMs: integer('duration_ms').notNull(),
  success: boolean('success').notNull(),
  error: text('error'),

  inputHash: varchar('input_hash', { length: 64 }),
  outputSizeBytes: integer('output_size_bytes'),
  resourceUsage: jsonb('resource_usage').$type<Record<string, unknown>>(),

  sessionId: uuid('session_id').references(() => voiceSessions.id),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  toolIdx: index('idx_sandbox_tool').on(table.toolName),
  timestampIdx: index('idx_sandbox_timestamp').on(table.timestamp),
}));

// ============================================================================
// Failure Drill Runs
// ============================================================================

export const failureDrillRuns = pgTable('failure_drill_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  drillType: varchar('drill_type', { length: 64 }).notNull(),
  scenario: varchar('scenario', { length: 128 }).notNull(),
  status: drillStatusEnum('status').notNull().default('running'),

  triggeredBy: uuid('triggered_by').references(() => operatorUsers.id),

  results: jsonb('results').$type<Record<string, unknown>>(),
  durationMs: integer('duration_ms'),

  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => ({
  drillTypeIdx: index('idx_drills_type').on(table.drillType),
  startedAtIdx: index('idx_drills_started_at').on(table.startedAt),
}));

// ============================================================================
// System Metrics Snapshots (Dashboard Time-Series)
// ============================================================================

export const systemMetricsSnapshots = pgTable('system_metrics_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),

  activeCalls: integer('active_calls').notNull(),
  agentsOnline: integer('agents_online').notNull(),
  cpuPct: real('cpu_pct'),
  memoryMb: real('memory_mb'),
  latencyP50Ms: integer('latency_p50_ms'),
  latencyP99Ms: integer('latency_p99_ms'),
  errorRate: real('error_rate'),
  callsLast5Min: integer('calls_last_5_min'),

  custom: jsonb('custom').$type<Record<string, unknown>>(),

  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  timestampIdx: index('idx_metrics_timestamp').on(table.timestamp),
}));

// ============================================================================
// DNC Suppression List
// ============================================================================

export const dncList = pgTable('dnc_list', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: varchar('phone', { length: 20 }).notNull().unique(),

  source: varchar('source', { length: 32 }).notNull(),
  reason: text('reason'),
  addedByConversationId: varchar('added_by_conversation_id', { length: 64 }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  phoneIdx: index('idx_dnc_phone').on(table.phone),
}));

// ============================================================================
// Router Training — adaptive_provider_router data collection
// ============================================================================

/**
 * Telemetry snapshot taken at routing decision time.
 * Composite PK (telemetry_snapshot_id, provider_id) — one row per provider per request.
 * For Phase 1 we capture the selected provider only; multi-candidate rows added later.
 */
export const telemetrySnapshots = pgTable('telemetry_snapshots', {
  telemetrySnapshotId: uuid('telemetry_snapshot_id').notNull().defaultRandom(),
  providerId: varchar('provider_id', { length: 64 }).notNull(),
  requestId: uuid('request_id').notNull(),
  taskType: varchar('task_type', { length: 64 }),
  estimatedLatencyMs: integer('estimated_latency_ms'),
  estimatedCostUsd: real('estimated_cost_usd'),
  providerAvailable: boolean('provider_available').notNull().default(true),
  snapshotAt: timestamp('snapshot_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.telemetrySnapshotId, table.providerId] }),
  requestIdx: index('idx_telemetry_request_id').on(table.requestId),
}));

/**
 * Pointwise binary ranking training set.
 * was_oracle_best is NULL until nightly oracle recompute job fills it in.
 * Unique on (request_id, provider_id) — one row per provider per request.
 * FK: (telemetry_snapshot_id, provider_id) → telemetry_snapshots composite PK.
 */
export const routerTrainingLog = pgTable('router_training_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull(),
  telemetrySnapshotId: uuid('telemetry_snapshot_id').notNull(),
  providerId: varchar('provider_id', { length: 64 }).notNull(),
  // Conversation linkage — used to UPDATE quality scores at call end
  conversationId: varchar('conversation_id', { length: 64 }),
  // Oracle labels — NULL until nightly recompute fills them in (24h lag)
  wasOracleBest: boolean('was_oracle_best'),
  qualityScoreSource: varchar('quality_score_source', { length: 32 }), // verifier|human|auto_eval|registry_baseline
  oracleTieCount: integer('oracle_tie_count'),
  // Outcome — captured post-call
  actualLatencyMs: integer('actual_latency_ms'),
  actualQualityScore: real('actual_quality_score'),
  callSuccess: boolean('call_success').notNull().default(false),
  wasFallback: boolean('was_fallback').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  requestProviderUniq: unique('uq_router_request_provider').on(table.requestId, table.providerId),
  snapshotFk: foreignKey({
    columns: [table.telemetrySnapshotId, table.providerId],
    foreignColumns: [telemetrySnapshots.telemetrySnapshotId, telemetrySnapshots.providerId],
  }),
  requestIdx: index('idx_router_log_request_id').on(table.requestId),
  conversationIdx: index('idx_router_log_conversation_id').on(table.conversationId),
  createdAtIdx: index('idx_router_log_created_at').on(table.createdAt),
}));
