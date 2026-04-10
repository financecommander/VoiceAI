/**
 * Session Service — Voice session persistence + conversation turn tracking
 *
 * Creates, updates, and closes voice sessions in Postgres.
 * Records every conversation turn for audit and session replay.
 */

import { eq, desc } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '../db/client.js';
import { voiceSessions, conversationTurns, routerTrainingLog } from '../db/schema.js';
import type { RouterLogEntry } from '../llm/provider.js';

export class SessionService {
  private db: Database;
  private logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child({ component: 'SessionService' });
  }

  async createSession(params: {
    callSid: string;
    streamSid?: string;
    model: string;
    direction: 'inbound' | 'outbound';
    callerPhone: string;
    calledPhone: string;
    callerState?: string;
  }): Promise<string> {
    const [session] = await this.db.insert(voiceSessions).values({
      callSid: params.callSid,
      streamSid: params.streamSid ?? null,
      model: params.model as any,
      direction: params.direction as any,
      status: 'ringing',
      callerPhone: params.callerPhone,
      calledPhone: params.calledPhone,
      callerState: params.callerState ?? null,
    }).returning({ id: voiceSessions.id });

    this.logger.info({ callSid: params.callSid, model: params.model }, 'Session created');
    return session.id;
  }

  async updateSessionStatus(callSid: string, status: string, extra?: Record<string, unknown>): Promise<void> {
    const updates: Record<string, unknown> = { status };
    if (extra) Object.assign(updates, extra);

    await this.db.update(voiceSessions).set(updates as any)
      .where(eq(voiceSessions.callSid, callSid));
  }

  async endSession(callSid: string, reason: string, durationMs: number): Promise<void> {
    await this.db.update(voiceSessions).set({
      status: 'completed',
      endReason: reason,
      durationMs,
      endedAt: new Date(),
    } as any).where(eq(voiceSessions.callSid, callSid));

    this.logger.info({ callSid, reason, durationMs }, 'Session ended');
  }

  async recordTurn(params: {
    sessionId: string;
    conversationId: string;
    turnNumber: number;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    llmProvider?: string;
    intent?: string;
    toolName?: string;
    toolCallId?: string;
    tokensUsed?: number;
    latencyMs?: number;
    wasFallback?: boolean;
  }): Promise<void> {
    await this.db.insert(conversationTurns).values({
      sessionId: params.sessionId,
      conversationId: params.conversationId,
      turnNumber: params.turnNumber,
      role: params.role as any,
      content: params.content,
      llmProvider: params.llmProvider ?? null,
      intent: params.intent ?? null,
      toolName: params.toolName ?? null,
      toolCallId: params.toolCallId ?? null,
      tokensUsed: params.tokensUsed ?? null,
      latencyMs: params.latencyMs ?? null,
      wasFallback: params.wasFallback ?? false,
    });
  }

  async getSessionTurns(sessionId: string): Promise<any[]> {
    return this.db.select()
      .from(conversationTurns)
      .where(eq(conversationTurns.sessionId, sessionId))
      .orderBy(conversationTurns.turnNumber);
  }

  async getSessionByCallSid(callSid: string) {
    const results = await this.db.select()
      .from(voiceSessions)
      .where(eq(voiceSessions.callSid, callSid))
      .limit(1);
    return results[0] ?? null;
  }

  /**
   * Insert a router training log row.
   * Fire-and-forget from LLM call path — caller must swallow errors.
   */
  async insertRouterLog(entry: RouterLogEntry): Promise<void> {
    await this.db.insert(routerTrainingLog).values({
      requestId: entry.requestId,
      telemetrySnapshotId: entry.telemetrySnapshotId,
      providerId: entry.provider,
      conversationId: entry.conversationId,
      actualLatencyMs: Math.round(entry.actualLatencyMs),
      callSuccess: entry.callSuccess,
      wasFallback: entry.wasFallback,
    });
  }

  /**
   * Update actual_quality_score on all router_training_log rows for a conversation.
   * Called once at call end, after ComplianceScorecard is generated.
   * quality_score_source = 'auto_eval' for scorecard-derived scores.
   */
  async updateRouterQualityScores(
    conversationId: string,
    score: number,
    source: 'auto_eval' | 'human' | 'verifier' | 'registry_baseline',
  ): Promise<void> {
    await this.db.update(routerTrainingLog)
      .set({ actualQualityScore: score, qualityScoreSource: source })
      .where(eq(routerTrainingLog.conversationId, conversationId));
    this.logger.debug({ conversationId, score, source }, 'Router quality scores updated');
  }
}
