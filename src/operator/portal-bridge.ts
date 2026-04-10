/**
 * Portal Bridge — AI Portal ↔ VoiceAI Swarm Session Integration
 *
 * Authenticated bridge that lets the AI Portal:
 *   - List active swarm sessions
 *   - View task details and status
 *   - Send control commands (pause, cancel, reassign)
 *   - Receive real-time updates via WebSocket
 */

import type WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { Logger } from 'pino';
import { OperatorAuthService } from './auth-middleware.js';

// ============================================================================
// Swarm Task Registry
// ============================================================================

export interface SwarmTaskRecord {
  taskId: string;
  caste: string;
  description: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  submittedAt: Date;
  completedAt: Date | null;
  result: unknown;
  submittedBy: string; // callSid or operator email
}

export class PortalBridge extends EventEmitter {
  private activeTasks = new Map<string, SwarmTaskRecord>();
  private portalClients = new Set<WebSocket>();
  private logger: Logger;
  private authService: OperatorAuthService;

  constructor(authService: OperatorAuthService, logger: Logger) {
    super();
    this.authService = authService;
    this.logger = logger.child({ component: 'PortalBridge' });
  }

  // ========================================================================
  // Task Tracking
  // ========================================================================

  /** Register a swarm task for portal visibility */
  trackTask(task: Omit<SwarmTaskRecord, 'submittedAt' | 'completedAt' | 'result' | 'status'>): void {
    const record: SwarmTaskRecord = {
      ...task,
      status: 'queued',
      submittedAt: new Date(),
      completedAt: null,
      result: null,
    };
    this.activeTasks.set(task.taskId, record);
    this.broadcastToPortal({ type: 'task:submitted', data: record });
  }

  /** Update task status */
  updateTaskStatus(taskId: string, status: SwarmTaskRecord['status'], result?: unknown): void {
    const task = this.activeTasks.get(taskId);
    if (!task) return;

    task.status = status;
    if (result !== undefined) task.result = result;
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      task.completedAt = new Date();
    }

    this.broadcastToPortal({ type: 'task:updated', data: task });

    // Clean up completed tasks after 5 minutes
    if (task.completedAt) {
      setTimeout(() => this.activeTasks.delete(taskId), 300_000);
    }
  }

  /** Get all tracked tasks */
  getTasks(): SwarmTaskRecord[] {
    return Array.from(this.activeTasks.values());
  }

  /** Get a specific task */
  getTask(taskId: string): SwarmTaskRecord | undefined {
    return this.activeTasks.get(taskId);
  }

  // ========================================================================
  // Portal WebSocket
  // ========================================================================

  /** Handle new portal WebSocket connection at /ws/portal */
  handleConnection(ws: WebSocket, token: string | null): void {
    if (!token) {
      ws.close(4001, 'auth_required');
      return;
    }

    const session = this.authService.verify(token);
    if (!session || (session.role !== 'portal_service' && session.role !== 'superadmin' && session.role !== 'operator')) {
      ws.close(4003, 'insufficient_permissions');
      return;
    }

    this.portalClients.add(ws);
    this.logger.info({ email: session.email, clients: this.portalClients.size }, 'Portal client connected');

    // Send current task state
    ws.send(JSON.stringify({
      type: 'initial_state',
      data: { tasks: this.getTasks() },
    }));

    // Handle incoming commands
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handlePortalCommand(msg, session.email);
      } catch (err: any) {
        this.logger.warn({ error: err?.message }, 'Invalid portal command');
      }
    });

    ws.on('close', () => {
      this.portalClients.delete(ws);
      this.logger.info({ clients: this.portalClients.size }, 'Portal client disconnected');
    });

    ws.on('error', () => {
      this.portalClients.delete(ws);
    });
  }

  private handlePortalCommand(msg: any, operatorEmail: string): void {
    switch (msg.command) {
      case 'cancel_task': {
        const task = this.activeTasks.get(msg.taskId);
        if (task && task.status !== 'completed' && task.status !== 'cancelled') {
          this.updateTaskStatus(msg.taskId, 'cancelled');
          this.logger.info({ taskId: msg.taskId, operator: operatorEmail }, 'Task cancelled via portal');
          this.emit('task:cancel', msg.taskId);
        }
        break;
      }
      case 'get_tasks':
        // Already sent on connect; this is a manual refresh
        break;
      default:
        this.logger.debug({ command: msg.command }, 'Unknown portal command');
    }
  }

  private broadcastToPortal(event: { type: string; data: unknown }): void {
    const msg = JSON.stringify(event);
    for (const ws of this.portalClients) {
      if (ws.readyState === 1) {
        ws.send(msg);
      }
    }
  }
}
