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
} from 'drizzle-orm/pg-core';

// ============================================================================
// Enums
// ============================================================================

export const calcModelEnum = pgEnum('calc_model', [
  'DMC', 'CONSTITUTIONAL_TENDER', 'TILT', 'EUREKA', 'IFSE',
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
]);

export const turnRoleEnum = pgEnum('turn_role', ['user', 'assistant', 'system', 'tool']);

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
