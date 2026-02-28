/**
 * Consent Service — PostgreSQL-backed TCPA consent tracking
 *
 * Tracks consent per phone number + model combination.
 * Supports capture, revocation, DNC list checking, and expiry.
 */

import { eq, and, desc } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '../db/client.js';
import { consentRecords, dncList } from '../db/schema.js';
import type { IConsentService } from './contracts.js';

export class ConsentServiceImpl implements IConsentService {
  private db: Database;
  private logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child({ component: 'ConsentService' });
  }

  async getConsent(phone: string, model?: string): Promise<any | null> {
    const conditions = [eq(consentRecords.phone, phone), eq(consentRecords.status, 'active')];
    if (model) {
      conditions.push(eq(consentRecords.model, model as any));
    }

    const results = await this.db.select()
      .from(consentRecords)
      .where(and(...conditions))
      .orderBy(desc(consentRecords.createdAt))
      .limit(1);

    if (!results.length) return null;

    const record = results[0];

    // Check expiry
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
      await this.db.update(consentRecords).set({ status: 'expired' })
        .where(eq(consentRecords.id, record.id));
      return null;
    }

    return {
      consentId: record.id,
      phone: record.phone,
      type: record.consentType,
      status: record.status,
      scope: record.scope,
      capturedAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  }

  async captureConsent(params: any): Promise<any> {
    const [record] = await this.db.insert(consentRecords).values({
      phone: params.phone,
      customerId: params.customerId ?? null,
      model: params.model as any,
      consentType: params.type as any,
      scope: params.scope ?? 'voice_ai',
      capturedVia: params.capturedVia,
      capturedConversationId: params.conversationId ?? null,
      capturedByAgent: true,
    }).returning();

    this.logger.info({
      phone: params.phone,
      model: params.model,
      type: params.type,
    }, 'Consent captured');

    return record;
  }

  async revokeConsent(phone: string, params?: any): Promise<void> {
    const conditions = [eq(consentRecords.phone, phone), eq(consentRecords.status, 'active')];
    if (params?.model) conditions.push(eq(consentRecords.model, params.model as any));

    await this.db.update(consentRecords).set({
      status: 'revoked',
      revokedAt: new Date(),
      revokedVia: 'voice_agent',
      revokedConversationId: params?.conversationId ?? null,
      updatedAt: new Date(),
    }).where(and(...conditions));

    this.logger.info({ phone }, 'Consent revoked');
  }

  async checkDNC(phone: string): Promise<{
    onNationalDNC: boolean;
    onStateDNC: boolean;
    onInternalSuppression: boolean;
    numberReassigned: boolean;
  }> {
    // Check internal suppression list
    const suppressed = await this.db.select()
      .from(dncList)
      .where(eq(dncList.phone, phone))
      .limit(1);

    // National and state DNC would be checked via external API (e.g., DNC.com)
    // For now, only check internal
    return {
      onNationalDNC: false,      // Would call external DNC API
      onStateDNC: false,          // Would call state DNC registries
      onInternalSuppression: suppressed.length > 0,
      numberReassigned: false,    // Would check via Twilio Lookup
    };
  }

  async addToSuppression(phone: string, reason: string, conversationId?: string): Promise<void> {
    await this.db.insert(dncList).values({
      phone,
      source: 'voice_agent',
      reason,
      addedByConversationId: conversationId ?? null,
    }).onConflictDoNothing();

    this.logger.info({ phone, reason }, 'Added to suppression list');
  }
}
