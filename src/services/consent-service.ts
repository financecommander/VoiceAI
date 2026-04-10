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
import type { IConsentService, CaptureConsentParams, ConsentRecord, RevocationParams } from './contracts.js';

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

  async captureConsent(params: CaptureConsentParams): Promise<ConsentRecord> {
    const [record] = await this.db.insert(consentRecords).values({
      phone: params.phone,
      customerId: params.customerId ?? null,
      model: 'DMC' as any, // Default model — caller should set via context
      consentType: params.consentType as any,
      scope: 'voice_ai',
      capturedVia: params.method,
      capturedConversationId: params.conversationId ?? null,
      capturedByAgent: true,
    }).returning();

    this.logger.info({
      phone: params.phone,
      type: params.consentType,
    }, 'Consent captured');

    // Map DB record to ConsentRecord interface
    return {
      phone: record.phone,
      customerId: record.customerId ?? undefined,
      aiWrittenConsent: params.consentType === 'ai_written',
      aiConsentTimestamp: params.consentType === 'ai_written' ? new Date() : null,
      aiConsentSeller: params.consentType === 'ai_written' ? params.seller : null,
      automatedConsent: params.consentType === 'automated',
      automatedConsentTimestamp: params.consentType === 'automated' ? new Date() : null,
      recordingConsent: params.consentType === 'recording',
      callbackRequested: params.consentType === 'callback',
      callbackRequestedAt: params.consentType === 'callback' ? new Date() : null,
      ebrStatus: false,
      ebrLastTransaction: null,
      revocationHistory: [],
      reOptedInAfterLastRevocation: false,
    };
  }

  async revokeConsent(phone: string, params: RevocationParams): Promise<void> {
    const conditions = [eq(consentRecords.phone, phone), eq(consentRecords.status, 'active')];
    if (params.scope === 'marketing_only') {
      conditions.push(eq(consentRecords.consentType, 'automated' as any));
    }

    await this.db.update(consentRecords).set({
      status: 'revoked',
      revokedAt: new Date(),
      revokedVia: params.method,
      revokedConversationId: params.conversationId ?? null,
      updatedAt: new Date(),
    }).where(and(...conditions));

    this.logger.info({ phone, method: params.method, scope: params.scope }, 'Consent revoked');
  }

  async checkDNC(phone: string): Promise<{
    onNationalDNC: boolean;
    onStateDNC: boolean;
    onInternalSuppression: boolean;
    numberReassigned: boolean;
  }> {
    // Query all DNC entries for this phone number across all sources
    const entries = await this.db.select()
      .from(dncList)
      .where(eq(dncList.phone, phone));

    const onNationalDNC = entries.some(e => e.source === 'national_dnc');
    const onStateDNC = entries.some(e => e.source === 'state_dnc');
    const onInternalSuppression = entries.some(
      e => !['national_dnc', 'state_dnc'].includes(e.source)
    );

    return {
      onNationalDNC,
      onStateDNC,
      onInternalSuppression,
      numberReassigned: false, // Future: check via Telnyx Number Lookup API
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
