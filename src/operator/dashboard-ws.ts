/**
 * Dashboard WebSocket — Real-time event push to operator dashboard
 *
 * Pushes: call events, metric snapshots, approval notifications,
 * compliance alerts, drill results, swarm events.
 */

import type WebSocket from 'ws';
import type { Logger } from 'pino';
import { callRegistry } from './call-registry.js';
import type { ApprovalService } from './approval-service.js';
import type { MetricsCollector } from './metrics-collector.js';
import { OperatorAuthService } from './auth-middleware.js';
import type { DashboardEvent } from './types.js';

export class DashboardWebSocketManager {
  private clients = new Set<WebSocket>();
  private logger: Logger;
  private metricsInterval: NodeJS.Timeout | null = null;

  constructor(
    private authService: OperatorAuthService,
    private approvalService: ApprovalService,
    private metricsCollector: MetricsCollector,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: 'DashboardWS' });
    this.wireEvents();
  }

  /** Handle new WebSocket connection at /ws/operator */
  handleConnection(ws: WebSocket, token: string | null): void {
    // Authenticate
    if (!token) {
      ws.close(4001, 'auth_required');
      return;
    }

    const session = this.authService.verify(token);
    if (!session) {
      ws.close(4001, 'invalid_token');
      return;
    }

    this.clients.add(ws);
    this.logger.info({ email: session.email, clients: this.clients.size }, 'Dashboard client connected');

    // Send initial state
    this.send(ws, {
      type: 'metric:snapshot',
      data: {
        ...this.metricsCollector.getOverview(),
        agentsOnline: this.metricsCollector.getOverview().agentsOnline.length,
        latencyP50Ms: null,
        latencyP99Ms: null,
        timestamp: new Date(),
      },
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      this.logger.info({ clients: this.clients.size }, 'Dashboard client disconnected');
    });

    ws.on('error', () => {
      this.clients.delete(ws);
    });
  }

  /** Start periodic metrics push */
  startMetricsPush(): void {
    if (this.metricsInterval) return;
    this.metricsInterval = setInterval(() => {
      if (this.clients.size === 0) return;
      const overview = this.metricsCollector.getOverview();
      this.broadcast({
        type: 'metric:snapshot',
        data: {
          ...overview,
          agentsOnline: overview.agentsOnline.length,
          latencyP50Ms: null,
          latencyP99Ms: null,
          timestamp: new Date(),
        },
      });
    }, 10_000);
  }

  stop(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
    for (const ws of this.clients) {
      ws.close(1001, 'server_shutdown');
    }
    this.clients.clear();
  }

  private wireEvents(): void {
    // Call events from registry
    callRegistry.on('call:started', (call) => {
      this.broadcast({
        type: 'call:started',
        data: { callSid: call.callSid, model: call.model, direction: call.direction },
      });
    });

    callRegistry.on('call:ended', (data) => {
      this.broadcast({
        type: 'call:ended',
        data,
      });
    });

    // Approval events
    this.approvalService.on('approval:new', (req) => {
      this.broadcast({ type: 'approval:new', data: req });
    });

    this.approvalService.on('approval:resolved', (data) => {
      this.broadcast({ type: 'approval:resolved', data });
    });
  }

  private broadcast(event: DashboardEvent): void {
    const msg = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === 1) { // OPEN
        ws.send(msg);
      }
    }
  }

  private send(ws: WebSocket, event: DashboardEvent): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(event));
    }
  }
}
