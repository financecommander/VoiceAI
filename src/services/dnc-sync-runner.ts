/**
 * DNC Sync Runner — CLI entry point for cron execution
 *
 * Usage:
 *   node dist/services/dnc-sync-runner.js --source national --file /data/dnc/national.txt
 *   node dist/services/dnc-sync-runner.js --source state   --dir  /data/dnc/states/
 *   node dist/services/dnc-sync-runner.js --status
 *
 * Cron (daily at 01:00 UTC):
 *   0 1 * * * node /opt/voiceai/dist/services/dnc-sync-runner.js --source national --file /data/dnc/national_latest.txt >> /var/log/dnc-sync.log 2>&1
 */

import { parseArgs } from 'node:util';
import { pino } from 'pino';
import { getDatabase } from '../db/client.js';
import { DncSyncService } from './dnc-sync.js';

const logger = pino({ level: 'info' });

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },   // 'national' | 'state'
      file:   { type: 'string' },   // path to single file
      dir:    { type: 'string' },   // path to directory of state files
      status: { type: 'boolean' },  // print sync status and exit
      clear:  { type: 'boolean' },  // clear existing records before import
    },
  });

  const db = getDatabase({
    connectionString: process.env.DATABASE_URL ?? '',
    maxConnections: 5,
    idleTimeoutMs: 10_000,
    connectionTimeoutMs: 5_000,
  }, logger);

  const sync = new DncSyncService(db, logger);

  // --status: print current record counts and exit
  if (values.status) {
    const status = await sync.getSyncStatus();
    console.log(JSON.stringify(status, null, 2));
    process.exit(0);
  }

  if (!values.source) {
    console.error('Error: --source (national|state) is required');
    process.exit(1);
  }

  const startMs = Date.now();

  if (values.source === 'national') {
    if (!values.file) {
      console.error('Error: --file is required for --source national');
      process.exit(1);
    }

    if (values.clear) {
      logger.info('Clearing existing national DNC records...');
      const deleted = await sync.clearRegistryRecords('national_dnc');
      logger.info({ deleted }, 'National DNC records cleared');
    }

    const result = await sync.importNationalDncFile(values.file);
    logger.info({
      ...result,
      totalDurationMs: Date.now() - startMs,
    }, 'National DNC sync complete');

  } else if (values.source === 'state') {
    if (!values.dir) {
      console.error('Error: --dir is required for --source state');
      process.exit(1);
    }

    if (values.clear) {
      logger.info('Clearing existing state DNC records...');
      const deleted = await sync.clearRegistryRecords('state_dnc');
      logger.info({ deleted }, 'State DNC records cleared');
    }

    const results = await sync.importStateDncDirectory(values.dir);
    const totalImported = results.reduce((s, r) => s + r.imported, 0);
    const totalSkipped  = results.reduce((s, r) => s + r.skipped, 0);
    logger.info({
      fileCount: results.length,
      totalImported,
      totalSkipped,
      totalDurationMs: Date.now() - startMs,
    }, 'State DNC sync complete');

  } else {
    console.error(`Error: unknown --source "${values.source}". Use: national | state`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => {
  logger.fatal({ err }, 'DNC sync runner crashed');
  process.exit(1);
});
