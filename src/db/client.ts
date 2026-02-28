/**
 * Database Client — Drizzle + PostgreSQL
 *
 * Connection pooling via pg Pool.
 * Used by all service implementations for persistence.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Logger } from 'pino';
import * as schema from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseConfig {
  connectionString: string;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
}

export const DEFAULT_DB_CONFIG: Partial<DatabaseConfig> = {
  maxConnections: 20,
  idleTimeoutMs: 30000,
  connectionTimeoutMs: 5000,
};

let pool: Pool | null = null;
let db: Database | null = null;

export function getDatabase(config: DatabaseConfig, logger: Logger): Database {
  if (db) return db;

  pool = new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
  });

  pool.on('error', (err: Error) => {
    logger.error({ error: err }, 'Database pool error');
  });

  db = drizzle(pool, { schema });

  logger.info({
    maxConnections: config.maxConnections,
  }, 'Database connected');

  return db;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

export { schema };
