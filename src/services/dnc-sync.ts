/**
 * DncSyncService — Federal + State DNC Registry Sync
 *
 * Imports phone number data from DNC.gov subscription downloads into
 * the local dnc_list table. The enforcer then queries this table on
 * every pre-dial check — no live external call required per dial.
 *
 * Sources:
 *   1. National DNC Registry (FTC) — downloaded via donotcall.gov subscription
 *   2. State DNC files — loaded from local files when available
 *   3. Internal opt-outs — written by the compliance enforcer in real-time
 *
 * Sync cadence (via cron):
 *   - National: once per 31 days (FTC data updated monthly)
 *   - State:    once per 31 days
 *   - Internal: real-time (written immediately on opt-out)
 *
 * DNC.gov data format:
 *   Text files, one E.164-compatible number per line (no country code prefix)
 *   e.g., "8005551234" or "800-555-1234"
 *
 * Usage:
 *   const sync = new DncSyncService(db, logger);
 *
 *   // Import from downloaded national DNC file
 *   await sync.importNationalDncFile('/path/to/national_dnc_20260318.txt');
 *
 *   // Import from directory of state DNC files
 *   await sync.importStateDncDirectory('/path/to/state_dnc/');
 *
 *   // Check sync status
 *   const status = await sync.getSyncStatus();
 */

import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '../db/client.js';
import { dncList } from '../db/schema.js';

// ============================================================================
// Types
// ============================================================================

export interface DncSyncResult {
  source: 'national_dnc' | 'state_dnc';
  filePath: string;
  totalLines: number;
  imported: number;
  skipped: number;        // Malformed or already present
  durationMs: number;
  completedAt: Date;
}

export interface DncSyncStatus {
  nationalLastSync: Date | null;
  nationalRecordCount: number;
  stateLastSync: Date | null;
  stateRecordCount: number;
  internalRecordCount: number;
  totalRecordCount: number;
}

// ============================================================================
// DncSyncService
// ============================================================================

export class DncSyncService {
  private db: Database;
  private logger: Logger;

  // Batch size for bulk inserts — keeps memory bounded on large files
  private static readonly BATCH_SIZE = 5_000;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child({ component: 'DncSyncService' });
  }

  // --------------------------------------------------------------------------
  // Import national DNC file (from DNC.gov subscription download)
  // --------------------------------------------------------------------------

  async importNationalDncFile(filePath: string): Promise<DncSyncResult> {
    return this.importFile(filePath, 'national_dnc');
  }

  // --------------------------------------------------------------------------
  // Import all state DNC files from a directory
  // Files should be named: state_dnc_CA.txt, state_dnc_TX.txt, etc.
  // --------------------------------------------------------------------------

  async importStateDncDirectory(dirPath: string): Promise<DncSyncResult[]> {
    const files = fs.readdirSync(dirPath)
      .filter(f => f.startsWith('state_dnc_') && f.endsWith('.txt'));

    if (files.length === 0) {
      this.logger.warn({ dirPath }, 'No state DNC files found in directory');
      return [];
    }

    this.logger.info({ dirPath, fileCount: files.length }, 'Starting state DNC import');
    const results: DncSyncResult[] = [];

    for (const file of files) {
      const result = await this.importFile(path.join(dirPath, file), 'state_dnc');
      results.push(result);
    }

    return results;
  }

  // --------------------------------------------------------------------------
  // Core import routine — reads file line by line, batch-upserts
  // --------------------------------------------------------------------------

  private async importFile(
    filePath: string,
    source: 'national_dnc' | 'state_dnc',
  ): Promise<DncSyncResult> {
    const startMs = Date.now();

    if (!fs.existsSync(filePath)) {
      throw new Error(`DNC file not found: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    this.logger.info(
      { filePath, source, sizeBytes: stat.size },
      'Starting DNC file import',
    );

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let totalLines = 0;
    let imported = 0;
    let skipped = 0;
    let batch: string[] = [];

    for await (const line of rl) {
      totalLines++;
      const phone = this.normalizePhone(line.trim());

      if (!phone) {
        skipped++;
        continue;
      }

      batch.push(phone);

      if (batch.length >= DncSyncService.BATCH_SIZE) {
        const result = await this.upsertBatch(batch, source);
        imported += result.inserted;
        skipped += result.skipped;
        batch = [];

        if (totalLines % 100_000 === 0) {
          this.logger.info(
            { filePath, source, totalLines, imported, skipped },
            'Import progress',
          );
        }
      }
    }

    // Flush remaining
    if (batch.length > 0) {
      const result = await this.upsertBatch(batch, source);
      imported += result.inserted;
      skipped += result.skipped;
    }

    const durationMs = Date.now() - startMs;
    const syncResult: DncSyncResult = {
      source,
      filePath,
      totalLines,
      imported,
      skipped,
      durationMs,
      completedAt: new Date(),
    };

    this.logger.info(syncResult, 'DNC file import complete');
    return syncResult;
  }

  // --------------------------------------------------------------------------
  // Batch upsert — inserts new records, ignores existing (phone is UNIQUE)
  // --------------------------------------------------------------------------

  private async upsertBatch(
    phones: string[],
    source: 'national_dnc' | 'state_dnc',
  ): Promise<{ inserted: number; skipped: number }> {
    if (phones.length === 0) return { inserted: 0, skipped: 0 };

    const rows = phones.map(phone => ({
      phone,
      source,
      reason: source === 'national_dnc'
        ? 'FTC National DNC Registry'
        : 'State DNC Registry',
    }));

    try {
      // onConflictDoNothing: if phone already exists (any source), skip
      // This means national_dnc won't overwrite an internal suppression — that's correct
      const result = await this.db.insert(dncList)
        .values(rows)
        .onConflictDoNothing()
        .returning({ id: dncList.id });

      return { inserted: result.length, skipped: phones.length - result.length };
    } catch (err) {
      this.logger.error({ err, source, batchSize: phones.length }, 'Batch upsert error');
      // Don't throw — log and continue; partial imports are better than none
      return { inserted: 0, skipped: phones.length };
    }
  }

  // --------------------------------------------------------------------------
  // Normalize phone to E.164 US format (+1XXXXXXXXXX)
  // DNC.gov files use various formats: "8005551234", "800-555-1234", "(800) 555-1234"
  // Returns null if not a valid 10-digit US number
  // --------------------------------------------------------------------------

  private normalizePhone(raw: string): string | null {
    // Strip all non-digit characters
    const digits = raw.replace(/\D/g, '');

    // Accept 10-digit (no country code) or 11-digit starting with 1
    if (digits.length === 10) {
      return `+1${digits}`;
    }
    if (digits.length === 11 && digits.startsWith('1')) {
      return `+${digits}`;
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // Get current sync status / record counts
  // --------------------------------------------------------------------------

  async getSyncStatus(): Promise<DncSyncStatus> {
    const counts = await this.db.execute(sql`
      SELECT
        source,
        COUNT(*)::int AS count,
        MAX(created_at) AS last_sync
      FROM dnc_list
      GROUP BY source
    `);

    const bySource: Record<string, { count: number; lastSync: Date | null }> = {};
    for (const row of counts.rows as any[]) {
      bySource[row.source] = {
        count: row.count,
        lastSync: row.last_sync ? new Date(row.last_sync) : null,
      };
    }

    const nationalData = bySource['national_dnc'];
    const stateData = bySource['state_dnc'];
    const internalCount = Object.entries(bySource)
      .filter(([src]) => !['national_dnc', 'state_dnc'].includes(src))
      .reduce((sum, [, v]) => sum + v.count, 0);

    const totalRecordCount = Object.values(bySource).reduce((sum, v) => sum + v.count, 0);

    return {
      nationalLastSync: nationalData?.lastSync ?? null,
      nationalRecordCount: nationalData?.count ?? 0,
      stateLastSync: stateData?.lastSync ?? null,
      stateRecordCount: stateData?.count ?? 0,
      internalRecordCount: internalCount,
      totalRecordCount,
    };
  }

  // --------------------------------------------------------------------------
  // Remove stale national/state records (call before re-importing fresh data)
  // Does NOT touch internal suppression records
  // --------------------------------------------------------------------------

  async clearRegistryRecords(source: 'national_dnc' | 'state_dnc'): Promise<number> {
    const result = await this.db.execute(
      sql`DELETE FROM dnc_list WHERE source = ${source} RETURNING id`
    );
    const deleted = (result.rows as any[]).length;
    this.logger.info({ source, deleted }, 'Cleared registry records');
    return deleted;
  }
}
