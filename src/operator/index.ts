/**
 * Operator Hardening Layer — Module index
 */

export * from './types.js';
export { callRegistry } from './call-registry.js';
export { OperatorAuthService, requirePermission, requireAuth, hasPermission, hasMinRole } from './auth-middleware.js';
export { ApprovalService } from './approval-service.js';
export { MetricsCollector } from './metrics-collector.js';
export { createDashboardRouter } from './dashboard-router.js';
export { DashboardWebSocketManager } from './dashboard-ws.js';
export { SandboxExecutor } from './sandbox.js';
export { PortalBridge } from './portal-bridge.js';
export { FailureDrillRunner, failureFlags } from './failure-drills.js';
