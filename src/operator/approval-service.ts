/**
 * Approval Service — Sensitive action workflow
 *
 * Certain actions require operator approval before execution.
 * Requests are queued, operators approve/reject via dashboard,
 * and auto-expire after TTL.
 */

import { eq, and, lt } from 'drizzle-orm';
import { EventEmitter } from 'events';
import type { Logger } from 'pino';
import type { Database } from '../db/client.js';
import { approvalRequests } from '../db/schema.js';
import type { ApprovalRequest, ApprovalStatus } from './types.js';

export class ApprovalService extends EventEmitter {
  private db: Database;
  private logger: Logger;
  private ttlMs: number;

  constructor(db: Database, logger: Logger, ttlMs: number = 300_000) {
    super();
    this.db = db;
    this.logger = logger.child({ component: 'ApprovalService' });
    this.ttlMs = ttlMs;

    // Expire stale approvals every 30s
    setInterval(() => this.expireStale(), 30_000);
  }

  async request(params: {
    actionType: string;
    description: string;
    requestedBy?: string;
    requestedByAgent?: string;
    context?: Record<string, unknown>;
  }): Promise<ApprovalRequest> {
    const [row] = await this.db.insert(approvalRequests).values({
      actionType: params.actionType,
      description: params.description,
      requestedBy: params.requestedBy ?? null,
      requestedByAgent: params.requestedByAgent ?? null,
      context: params.context ?? {},
      expiresAt: new Date(Date.now() + this.ttlMs),
    }).returning();

    const req = this.rowToRequest(row);
    this.logger.info({ id: req.id, action: req.actionType }, 'Approval requested');
    this.emit('approval:new', req);
    return req;
  }

  async approve(requestId: string, approvedBy: string): Promise<ApprovalRequest | null> {
    const [row] = await this.db.update(approvalRequests)
      .set({
        status: 'approved',
        approvedBy,
        resolvedAt: new Date(),
      } as any)
      .where(and(eq(approvalRequests.id, requestId), eq(approvalRequests.status, 'pending')))
      .returning();

    if (!row) return null;
    const req = this.rowToRequest(row);
    this.logger.info({ id: req.id, action: req.actionType, approvedBy }, 'Approval granted');
    this.emit('approval:resolved', { id: req.id, status: 'approved' });
    return req;
  }

  async reject(requestId: string, rejectedBy: string): Promise<ApprovalRequest | null> {
    const [row] = await this.db.update(approvalRequests)
      .set({
        status: 'rejected',
        approvedBy: rejectedBy,
        resolvedAt: new Date(),
      } as any)
      .where(and(eq(approvalRequests.id, requestId), eq(approvalRequests.status, 'pending')))
      .returning();

    if (!row) return null;
    const req = this.rowToRequest(row);
    this.logger.info({ id: req.id, action: req.actionType, rejectedBy }, 'Approval rejected');
    this.emit('approval:resolved', { id: req.id, status: 'rejected' });
    return req;
  }

  async getPending(): Promise<ApprovalRequest[]> {
    const rows = await this.db.select()
      .from(approvalRequests)
      .where(eq(approvalRequests.status, 'pending'));
    return rows.map(r => this.rowToRequest(r));
  }

  async getById(id: string): Promise<ApprovalRequest | null> {
    const rows = await this.db.select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .limit(1);
    return rows[0] ? this.rowToRequest(rows[0]) : null;
  }

  private async expireStale(): Promise<void> {
    const expired = await this.db.update(approvalRequests)
      .set({ status: 'expired', resolvedAt: new Date() } as any)
      .where(and(
        eq(approvalRequests.status, 'pending'),
        lt(approvalRequests.expiresAt, new Date()),
      ))
      .returning({ id: approvalRequests.id });

    if (expired.length > 0) {
      this.logger.info({ count: expired.length }, 'Expired stale approval requests');
    }
  }

  private rowToRequest(row: any): ApprovalRequest {
    return {
      id: row.id,
      actionType: row.actionType,
      description: row.description,
      requestedBy: row.requestedBy,
      requestedByAgent: row.requestedByAgent,
      status: row.status as ApprovalStatus,
      approvedBy: row.approvedBy,
      context: (row.context as Record<string, unknown>) ?? {},
      expiresAt: row.expiresAt,
      requestedAt: row.requestedAt,
      resolvedAt: row.resolvedAt,
    };
  }
}
