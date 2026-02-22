/**
 * KyberBot — Sleep Agent Status
 *
 * Provides status data for the observability dashboard.
 * Queries sleep.db and timeline.db for health, metrics, and distribution.
 */

import { getSleepDb } from './db.js';
import { getTimelineDb } from '../timeline.js';
import { DEFAULT_CONFIG } from './config.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('sleep-status');

export interface SleepStatusData {
  health: 'healthy' | 'degraded' | 'unhealthy';
  state: 'idle' | 'running' | 'error';
  lastRun: {
    timestamp: string;
    agoMs: number;
    decay: number;
    tag: number;
    link: number;
    tier: number;
    summarize: number;
    entityHygiene: number;
    durationMs: number;
    errors: string[];
  } | null;
  nextRunIn: number | null;
  tiers: {
    hot: number;
    warm: number;
    archive: number;
  };
  edges: {
    total: number;
    avgConfidence: number;
  };
  enrichment: {
    tagged: number;
    total: number;
    stale: number;
  };
  consecutiveFailures: number;
  recentTelemetry: Array<{
    step: string;
    count: number;
    durationMs: number;
    timestamp: string;
  }>;
}

export async function getSleepStatusData(root: string): Promise<SleepStatusData> {
  try {
    const sleepDb = getSleepDb(root);
    const timelineDb = await getTimelineDb(root);

    // Last run
    const lastRunRow = sleepDb.prepare(`
      SELECT id, started_at, completed_at, status, metrics, error_message
      FROM sleep_runs
      ORDER BY started_at DESC
      LIMIT 1
    `).get() as {
      id: number;
      started_at: string;
      completed_at: string | null;
      status: string;
      metrics: string | null;
      error_message: string | null;
    } | undefined;

    let lastRun: SleepStatusData['lastRun'] = null;
    let state: SleepStatusData['state'] = 'idle';

    if (lastRunRow) {
      const metrics = lastRunRow.metrics ? JSON.parse(lastRunRow.metrics) : {};
      // SQLite datetime('now') stores UTC - append 'Z' so JS parses correctly
      const startedAt = new Date(lastRunRow.started_at + 'Z').getTime();
      const completedAt = lastRunRow.completed_at ? new Date(lastRunRow.completed_at + 'Z').getTime() : Date.now();

      if (lastRunRow.status === 'running') {
        state = 'running';
      } else if (lastRunRow.status === 'failed') {
        state = 'error';
      }

      // Extract counts from step results (stored as {count, durationMs, errors?})
      const extractCount = (step: unknown): number => {
        if (typeof step === 'number') return step;
        if (step && typeof step === 'object' && 'count' in step) return (step as { count: number }).count;
        return 0;
      };

      // Collect errors from all steps
      const allErrors: string[] = [];
      for (const step of Object.values(metrics)) {
        if (step && typeof step === 'object' && 'errors' in step) {
          const stepErrors = (step as { errors: string[] }).errors;
          if (Array.isArray(stepErrors)) allErrors.push(...stepErrors);
        }
      }

      lastRun = {
        timestamp: lastRunRow.started_at,
        agoMs: Date.now() - startedAt,
        decay: extractCount(metrics.decay),
        tag: extractCount(metrics.tag),
        link: extractCount(metrics.link),
        tier: extractCount(metrics.tier),
        summarize: extractCount(metrics.summarize),
        entityHygiene: extractCount(metrics.entityHygiene),
        durationMs: completedAt - startedAt,
        errors: allErrors,
      };
    }

    // Next run estimate (interval from config)
    const intervalMs = DEFAULT_CONFIG.intervalMinutes * 60 * 1000;
    let nextRunIn: number | null = null;
    if (lastRun && state !== 'running') {
      const elapsed = lastRun.agoMs;
      nextRunIn = Math.max(0, intervalMs - elapsed);
    }

    // Health determination
    const maxHealthyGap = DEFAULT_CONFIG.intervalMinutes * 1.5 * 60 * 1000;
    let health: SleepStatusData['health'] = 'healthy';
    if (!lastRun) {
      health = 'unhealthy';
    } else if (lastRun.agoMs > maxHealthyGap * 2) {
      health = 'unhealthy';
    } else if (lastRun.agoMs > maxHealthyGap || state === 'error') {
      health = 'degraded';
    }

    // Tier distribution
    const tierRows = timelineDb.prepare(`
      SELECT tier, COUNT(*) as count
      FROM timeline_events
      GROUP BY tier
    `).all() as Array<{ tier: string; count: number }>;

    const tiers = { hot: 0, warm: 0, archive: 0 };
    for (const row of tierRows) {
      if (row.tier === 'hot') tiers.hot = row.count;
      else if (row.tier === 'warm') tiers.warm = row.count;
      else if (row.tier === 'archive') tiers.archive = row.count;
    }

    // Memory edges
    const edgeStats = sleepDb.prepare(`
      SELECT COUNT(*) as total, COALESCE(AVG(confidence), 0) as avgConfidence
      FROM memory_edges
    `).get() as { total: number; avgConfidence: number };

    // Enrichment coverage
    const totalItems = timelineDb.prepare(`
      SELECT COUNT(*) as count FROM timeline_events
    `).get() as { count: number };

    const taggedItems = timelineDb.prepare(`
      SELECT COUNT(*) as count FROM timeline_events
      WHERE tags_json IS NOT NULL AND tags_json != '[]'
    `).get() as { count: number };

    const staleDate = new Date(
      Date.now() - DEFAULT_CONFIG.tagStaleDays * 24 * 60 * 60 * 1000
    ).toISOString();

    const staleItems = timelineDb.prepare(`
      SELECT COUNT(*) as count FROM timeline_events
      WHERE last_enriched IS NULL OR last_enriched < ?
    `).get(staleDate) as { count: number };

    // Consecutive failures
    const recentRuns = sleepDb.prepare(`
      SELECT status FROM sleep_runs
      ORDER BY started_at DESC
      LIMIT 10
    `).all() as Array<{ status: string }>;

    let consecutiveFailures = 0;
    for (const run of recentRuns) {
      if (run.status === 'failed') consecutiveFailures++;
      else break;
    }

    if (consecutiveFailures >= 3) {
      health = 'unhealthy';
    }

    // Recent telemetry (last cycle's step metrics)
    const recentTelemetry = sleepDb.prepare(`
      SELECT step, count, duration_ms as durationMs, created_at as timestamp
      FROM sleep_telemetry
      WHERE run_id = (SELECT MAX(id) FROM sleep_runs WHERE status = 'completed')
      ORDER BY created_at ASC
    `).all() as Array<{
      step: string;
      count: number;
      durationMs: number;
      timestamp: string;
    }>;

    return {
      health,
      state,
      lastRun,
      nextRunIn,
      tiers,
      edges: {
        total: edgeStats.total,
        avgConfidence: Math.round(edgeStats.avgConfidence * 100) / 100,
      },
      enrichment: {
        tagged: taggedItems.count,
        total: totalItems.count,
        stale: staleItems.count,
      },
      consecutiveFailures,
      recentTelemetry,
    };
  } catch (error) {
    logger.error('Failed to get sleep status', { error: String(error) });
    return {
      health: 'unhealthy',
      state: 'error',
      lastRun: null,
      nextRunIn: null,
      tiers: { hot: 0, warm: 0, archive: 0 },
      edges: { total: 0, avgConfidence: 0 },
      enrichment: { tagged: 0, total: 0, stale: 0 },
      consecutiveFailures: 0,
      recentTelemetry: [],
    };
  }
}
