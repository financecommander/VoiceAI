/**
 * Audit Service — PostgreSQL-backed compliance audit trail
 *
 * Writes immutable audit events to the audit_events table.
 * Every compliance-relevant action is logged for regulatory review.
 */

import { eq, desc } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '../db/client.js';
import { auditEvents, voiceSessions } from '../db/schema.js';
import type { AuditEvent, AuditEventType } from '../types.js';
import type { IAuditService } from './contracts.js';

export class AuditServiceImpl implements IAuditService {
  private db: Database;
  private logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child({ component: 'AuditService' });
  }

  async logEvent(event: Omit<AuditEvent, 'eventId'>): Promise<string> {
    try {
      // Find session ID from conversation ID
      let sessionId: string | null = null;
      if (event.conversationId) {
        const sessions = await this.db.select({ id: voiceSessions.id })
          .from(voiceSessions)
          .where(eq(voiceSessions.callSid, event.conversationId))
          .limit(1);
        sessionId = sessions[0]?.id ?? null;
      }

      const [inserted] = await this.db.insert(auditEvents).values({
        sessionId,
        conversationId: event.conversationId ?? '',
        eventType: event.eventType as any,
        model: event.model as any,
        authTier: String(event.authTier) as any,
        customerId: event.customerId ?? null,
        intent: event.intent ?? null,
        action: event.action ?? null,
        result: event.result ?? null,
        metadata: event.metadata ?? null,
        createdByAgent: event.createdByAgent ?? true,
        timestamp: event.timestamp ?? new Date(),
      }).returning({ id: auditEvents.id });

      return inserted.id;
    } catch (error) {
      this.logger.error({ error, event: event.eventType }, 'Failed to write audit event');
      // Never throw from audit — log and return empty
      return '';
    }
  }

  async getConversationAudit(conversationId: string): Promise<AuditEvent[]> {
    const rows = await this.db.select()
      .from(auditEvents)
      .where(eq(auditEvents.conversationId, conversationId))
      .orderBy(desc(auditEvents.timestamp));

    return rows.map(row => ({
      eventId: row.id,
      conversationId: row.conversationId,
      model: row.model as any,
      eventType: row.eventType as AuditEventType,
      authTier: Number(row.authTier),
      customerId: row.customerId ?? null,
      intent: (row.intent as any) ?? null,
      action: row.action ?? null,
      result: row.result ?? null,
      metadata: (row.metadata as any) ?? null,
      createdByAgent: row.createdByAgent,
      timestamp: row.timestamp,
    }));
  }
}
