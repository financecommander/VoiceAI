/**
 * Dashboard Router — REST API for operator dashboard
 *
 * All endpoints under /api/operator/
 * Protected by JWT operator auth + role-based permissions.
 */

import { Router } from 'express';
import { desc, eq, gt, and, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '../db/client.js';
import { voiceSessions, auditEvents, conversationTurns } from '../db/schema.js';
import { OperatorAuthService, requirePermission, requireAuth } from './auth-middleware.js';
import { ApprovalService } from './approval-service.js';
import { MetricsCollector } from './metrics-collector.js';
import { callRegistry } from './call-registry.js';
import type { OperatorRole } from './types.js';

export interface DashboardRouterDeps {
  db: Database;
  authService: OperatorAuthService;
  approvalService: ApprovalService;
  metricsCollector: MetricsCollector;
  logger: Logger;
}

export function createDashboardRouter(deps: DashboardRouterDeps): Router {
  const { db, authService, approvalService, metricsCollector, logger } = deps;
  const router = Router();
  const log = logger.child({ component: 'DashboardAPI' });

  // ========================================================================
  // Auth
  // ========================================================================

  router.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: 'email and password required' });
      return;
    }

    const result = await authService.login(
      email, password,
      req.ip ?? undefined,
      req.headers['user-agent'] ?? undefined,
    );

    if (!result) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    res.json({ token: result.token, user: result.user });
  });

  router.post('/auth/logout', requireAuth(authService), async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) await authService.logout(token);
    res.json({ status: 'ok' });
  });

  router.get('/auth/me', requireAuth(authService), (req, res) => {
    res.json(req.operator);
  });

  // ========================================================================
  // Dashboard Overview
  // ========================================================================

  router.get('/dashboard/overview',
    requirePermission('dashboard:read', authService),
    (_req, res) => {
      res.json(metricsCollector.getOverview());
    },
  );

  router.get('/dashboard/metrics',
    requirePermission('dashboard:read', authService),
    async (req, res) => {
      const minutes = parseInt(req.query.minutes as string) || 60;
      const history = await metricsCollector.getHistory(Math.min(minutes, 1440));
      res.json(history);
    },
  );

  // ========================================================================
  // Active Calls
  // ========================================================================

  router.get('/calls/active',
    requirePermission('calls:read', authService),
    (_req, res) => {
      res.json(callRegistry.getAll());
    },
  );

  router.get('/calls/history',
    requirePermission('calls:read', authService),
    async (req, res) => {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;

      const rows = await db.select()
        .from(voiceSessions)
        .orderBy(desc(voiceSessions.startedAt))
        .limit(limit)
        .offset(offset);

      res.json({ calls: rows, limit, offset });
    },
  );

  router.get('/calls/:callSid',
    requirePermission('calls:read', authService),
    async (req, res) => {
      const rows = await db.select()
        .from(voiceSessions)
        .where(eq(voiceSessions.callSid, req.params.callSid as string))
        .limit(1);

      if (!rows[0]) {
        res.status(404).json({ error: 'Call not found' });
        return;
      }

      // Include turns
      const session = rows[0];
      const turns = await db.select()
        .from(conversationTurns)
        .where(eq(conversationTurns.sessionId, session.id))
        .orderBy(conversationTurns.turnNumber);

      res.json({ ...session, turns });
    },
  );

  router.post('/calls/:callSid/kill',
    requirePermission('calls:kill', authService),
    async (req, res) => {
      const callSid = req.params.callSid as string;
      const active = callRegistry.get(callSid);
      if (!active) {
        res.status(404).json({ error: 'Call not active' });
        return;
      }

      log.warn({ callSid, operator: req.operator?.email }, 'Force killing call');
      callRegistry.unregister(callSid, 'force_killed');
      res.json({ status: 'killed', callSid });
    },
  );

  // ========================================================================
  // Agents
  // ========================================================================

  router.get('/agents/status',
    requirePermission('agents:read', authService),
    (_req, res) => {
      const calls = callRegistry.getAll();
      const byModel: Record<string, { activeCalls: number; model: string }> = {};

      for (const call of calls) {
        if (!byModel[call.model]) {
          byModel[call.model] = { model: call.model, activeCalls: 0 };
        }
        byModel[call.model].activeCalls++;
      }

      // Include models with 0 calls
      for (const m of ['JACK', 'JENNY', 'BUNNY', 'DMC', 'TILT', 'EUREKA', 'IFSE']) {
        if (!byModel[m]) byModel[m] = { model: m, activeCalls: 0 };
      }

      res.json(Object.values(byModel));
    },
  );

  // ========================================================================
  // Audit
  // ========================================================================

  router.get('/audit/events',
    requirePermission('audit:read', authService),
    async (req, res) => {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
      const offset = parseInt(req.query.offset as string) || 0;
      const eventType = req.query.eventType as string | undefined;

      const rows = await db.select().from(auditEvents)
        .where(eventType ? eq(auditEvents.eventType, eventType as any) : undefined)
        .orderBy(desc(auditEvents.timestamp))
        .limit(limit)
        .offset(offset);
      res.json({ events: rows, limit, offset });
    },
  );

  // ========================================================================
  // Approvals
  // ========================================================================

  router.get('/approvals/pending',
    requirePermission('approvals:read', authService),
    async (_req, res) => {
      const pending = await approvalService.getPending();
      res.json(pending);
    },
  );

  router.post('/approvals/:id/approve',
    requirePermission('approvals:decide', authService),
    async (req, res) => {
      const result = await approvalService.approve(req.params.id as string, req.operator!.userId);
      if (!result) {
        res.status(404).json({ error: 'Approval not found or already resolved' });
        return;
      }
      res.json(result);
    },
  );

  router.post('/approvals/:id/reject',
    requirePermission('approvals:decide', authService),
    async (req, res) => {
      const result = await approvalService.reject(req.params.id as string, req.operator!.userId);
      if (!result) {
        res.status(404).json({ error: 'Approval not found or already resolved' });
        return;
      }
      res.json(result);
    },
  );

  // ========================================================================
  // Users (superadmin only)
  // ========================================================================

  router.get('/users',
    requirePermission('users:manage', authService),
    async (_req, res) => {
      const users = await authService.listUsers();
      res.json(users);
    },
  );

  router.post('/users',
    requirePermission('users:manage', authService),
    async (req, res) => {
      const { email, password, name, role } = req.body;
      if (!email || !password || !name || !role) {
        res.status(400).json({ error: 'email, password, name, role required' });
        return;
      }
      const id = await authService.createUser(email, password, name, role as OperatorRole);
      log.info({ email, role, createdBy: req.operator?.email }, 'User created via dashboard');
      res.json({ id, email, role });
    },
  );

  return router;
}
