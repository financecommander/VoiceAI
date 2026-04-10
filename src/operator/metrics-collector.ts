/**
 * Metrics Collector — System health aggregation for dashboard
 *
 * Samples system state every 10 seconds and stores snapshots.
 * Provides real-time and historical metrics for the operator dashboard.
 */

import type { Logger } from 'pino';
import type { Database } from '../db/client.js';
import { systemMetricsSnapshots } from '../db/schema.js';
import { desc, gt } from 'drizzle-orm';
import { callRegistry } from './call-registry.js';
import type { MetricsSnapshot, SystemOverview } from './types.js';

export class MetricsCollector {
  private db: Database | null;
  private logger: Logger;
  private interval: NodeJS.Timeout | null = null;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuTime = Date.now();

  constructor(db: Database | null, logger: Logger) {
    this.db = db;
    this.logger = logger.child({ component: 'MetricsCollector' });
  }

  /** Start periodic collection (every 10s) */
  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.collect(), 10_000);
    this.logger.info('Metrics collector started');
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Get current system overview (real-time, no DB) */
  getOverview(): SystemOverview {
    const mem = process.memoryUsage();
    const cpu = this.getCpuPercent();
    const calls = callRegistry.getAll();

    const models = new Set(calls.map(c => c.model));

    return {
      activeCalls: calls.length,
      agentsOnline: Array.from(models),
      uptime: process.uptime(),
      memoryMb: Math.round(mem.heapUsed / 1024 / 1024),
      cpuPct: cpu,
      callsLast5Min: calls.length, // Approximate — full impl would track recent completions
      errorRate: 0,
    };
  }

  /** Get historical snapshots (from DB) */
  async getHistory(minutes: number = 60): Promise<MetricsSnapshot[]> {
    if (!this.db) return [];
    const since = new Date(Date.now() - minutes * 60_000);
    const rows = await this.db.select()
      .from(systemMetricsSnapshots)
      .where(gt(systemMetricsSnapshots.timestamp, since))
      .orderBy(desc(systemMetricsSnapshots.timestamp))
      .limit(360); // Max 1 hour at 10s intervals

    return rows.map(r => ({
      activeCalls: r.activeCalls,
      agentsOnline: r.agentsOnline,
      cpuPct: r.cpuPct,
      memoryMb: r.memoryMb,
      latencyP50Ms: r.latencyP50Ms,
      latencyP99Ms: r.latencyP99Ms,
      errorRate: r.errorRate,
      callsLast5Min: r.callsLast5Min,
      timestamp: r.timestamp,
    }));
  }

  /** Take a single snapshot */
  private async collect(): Promise<void> {
    const overview = this.getOverview();

    if (!this.db) return;

    try {
      await this.db.insert(systemMetricsSnapshots).values({
        activeCalls: overview.activeCalls,
        agentsOnline: overview.agentsOnline.length,
        cpuPct: overview.cpuPct,
        memoryMb: overview.memoryMb,
        errorRate: overview.errorRate,
        callsLast5Min: overview.callsLast5Min,
      });
    } catch (err: any) {
      this.logger.warn({ error: err?.message }, 'Failed to store metrics snapshot');
    }
  }

  private getCpuPercent(): number {
    const now = Date.now();
    const elapsed = now - this.lastCpuTime;
    if (elapsed < 1000) return 0;

    const usage = process.cpuUsage(this.lastCpuUsage);
    const totalMicros = usage.user + usage.system;
    const pct = (totalMicros / 1000 / elapsed) * 100;

    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = now;

    return Math.round(pct * 10) / 10;
  }
}
