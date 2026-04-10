/**
 * Operator Hardening Layer — Types
 *
 * Shared interfaces for dashboard, permissions, approvals, sandboxing,
 * audit, portal integration, and failure drills.
 */

// ============================================================================
// Operator Auth
// ============================================================================

export type OperatorRole = 'superadmin' | 'operator' | 'viewer' | 'portal_service';

export interface OperatorUser {
  id: string;
  email: string;
  name: string;
  role: OperatorRole;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface OperatorSession {
  userId: string;
  email: string;
  name: string;
  role: OperatorRole;
}

/** Role hierarchy — higher index = more privilege */
export const ROLE_HIERARCHY: OperatorRole[] = ['viewer', 'portal_service', 'operator', 'superadmin'];

// ============================================================================
// Permissions
// ============================================================================

export type PermissionAction =
  | 'dashboard:read'
  | 'calls:read'
  | 'calls:kill'
  | 'agents:read'
  | 'agents:configure'
  | 'audit:read'
  | 'approvals:read'
  | 'approvals:decide'
  | 'users:manage'
  | 'config:change'
  | 'drills:trigger'
  | 'drills:read'
  | 'swarm:read'
  | 'swarm:control'
  | 'portal:connect';

export const ROLE_PERMISSIONS: Record<OperatorRole, PermissionAction[]> = {
  viewer: [
    'dashboard:read', 'calls:read', 'agents:read', 'audit:read',
    'approvals:read', 'drills:read', 'swarm:read',
  ],
  portal_service: [
    'swarm:read', 'swarm:control', 'portal:connect',
  ],
  operator: [
    'dashboard:read', 'calls:read', 'calls:kill', 'agents:read',
    'audit:read', 'approvals:read', 'approvals:decide',
    'drills:trigger', 'drills:read', 'swarm:read', 'swarm:control',
  ],
  superadmin: [
    'dashboard:read', 'calls:read', 'calls:kill',
    'agents:read', 'agents:configure',
    'audit:read', 'approvals:read', 'approvals:decide',
    'users:manage', 'config:change',
    'drills:trigger', 'drills:read',
    'swarm:read', 'swarm:control', 'portal:connect',
  ],
};

// ============================================================================
// Approvals
// ============================================================================

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'auto_approved';

export interface ApprovalRequest {
  id: string;
  actionType: string;
  description: string;
  requestedBy: string | null;
  requestedByAgent: string | null;
  status: ApprovalStatus;
  approvedBy: string | null;
  context: Record<string, unknown>;
  expiresAt: Date;
  requestedAt: Date;
  resolvedAt: Date | null;
}

/** Actions that require operator approval before execution */
export const APPROVAL_REQUIRED_ACTIONS = [
  'session_force_kill',
  'config_change',
  'user_create',
  'user_deactivate',
  'drill_trigger',
  'swarm_cancel_task',
] as const;

// ============================================================================
// Sandbox
// ============================================================================

export type SandboxTrustLevel = 'trusted' | 'semi_trusted' | 'untrusted';

export interface SandboxPolicy {
  trustLevel: SandboxTrustLevel;
  timeoutMs: number;
  maxOutputBytes: number;
  isolated: boolean;
}

export interface SandboxResult<T = unknown> {
  success: boolean;
  result?: T;
  error?: string;
  durationMs: number;
  isolated: boolean;
}

// ============================================================================
// Failure Drills
// ============================================================================

export type DrillType =
  | 'llm_failover'
  | 'stt_outage'
  | 'tts_outage'
  | 'db_latency'
  | 'swarm_unreachable'
  | 'concurrent_spike';

export type DrillStatus = 'running' | 'passed' | 'failed' | 'aborted';

export interface DrillRun {
  id: string;
  drillType: DrillType;
  scenario: string;
  status: DrillStatus;
  triggeredBy: string | null;
  results: Record<string, unknown> | null;
  durationMs: number | null;
  startedAt: Date;
  completedAt: Date | null;
}

// ============================================================================
// Dashboard Metrics
// ============================================================================

export interface SystemOverview {
  activeCalls: number;
  agentsOnline: string[];
  uptime: number;
  memoryMb: number;
  cpuPct: number;
  callsLast5Min: number;
  errorRate: number;
}

export interface MetricsSnapshot {
  activeCalls: number;
  agentsOnline: number;
  cpuPct: number | null;
  memoryMb: number | null;
  latencyP50Ms: number | null;
  latencyP99Ms: number | null;
  errorRate: number | null;
  callsLast5Min: number | null;
  timestamp: Date;
}

// ============================================================================
// WebSocket Events (Dashboard Push)
// ============================================================================

export type DashboardEvent =
  | { type: 'call:started'; data: { callSid: string; model: string; direction: string } }
  | { type: 'call:ended'; data: { callSid: string; reason: string; durationMs: number } }
  | { type: 'metric:snapshot'; data: MetricsSnapshot }
  | { type: 'alert:compliance'; data: { sessionId: string; gate: string; detail: string } }
  | { type: 'approval:new'; data: ApprovalRequest }
  | { type: 'approval:resolved'; data: { id: string; status: ApprovalStatus } }
  | { type: 'drill:started'; data: { id: string; drillType: DrillType } }
  | { type: 'drill:completed'; data: DrillRun }
  | { type: 'swarm:event'; data: Record<string, unknown> };
