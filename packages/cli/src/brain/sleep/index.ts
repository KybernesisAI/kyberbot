/**
 * KyberBot — Sleep Agent Service
 *
 * Background maintenance agent that continuously improves the knowledge base.
 * Runs every hour (configurable) and performs 6 steps:
 * 1. Decay: Age-based priority reduction
 * 2. Tag: AI-refresh stale tags
 * 3. Link: Build relationships between memories
 * 4. Tier: Move items between hot/warm/archive
 * 5. Summarize: Regenerate summaries for changed items
 * 6. Entity Hygiene: Clean duplicates, merge variants, prune noise in entity graph
 */

import { createLogger } from '../../logger.js';
import { ServiceHandle } from '../../types.js';
import { getSleepDb, initializeSleepDb } from './db.js';
import { SleepConfig, DEFAULT_CONFIG } from './config.js';
import { runDecayStep, DecayResult } from './steps/decay.js';
import { runTagStep, TagResult } from './steps/tag.js';
import { runLinkStep, LinkResult } from './steps/link.js';
import { runTierStep, TierResult } from './steps/tier.js';
import { runSummarizeStep, SummarizeResult } from './steps/summarize.js';
import { runEntityHygieneStep, EntityHygieneResult } from './steps/entity-hygiene.js';
import { runConsolidateStep, ConsolidateResult } from './steps/consolidate.js';
import { runObserveStep, ObserveResult } from './steps/observe.js';
import { runProfileStep, ProfileResult } from './steps/profile.js';
import { runReasoningStep, ReasoningResult } from './steps/reasoning.js';
import { saveCheckpoint } from './utils/checkpoint.js';

const logger = createLogger('sleep-agent');

export interface RunMetrics {
  decay: DecayResult & { durationMs: number };
  tag: TagResult & { durationMs: number };
  consolidate?: ConsolidateResult & { durationMs: number };
  link: LinkResult & { durationMs: number };
  tier: TierResult & { durationMs: number };
  summarize: SummarizeResult & { durationMs: number };
  observe?: ObserveResult & { durationMs: number };
  reasoning?: ReasoningResult & { durationMs: number };
  profile?: ProfileResult & { durationMs: number };
  entityHygiene?: EntityHygieneResult & { durationMs: number };
  totalDurationMs: number;
}

export async function startSleepAgent(
  root: string,
  config: Partial<SleepConfig> = {}
): Promise<ServiceHandle> {
  const cfg: SleepConfig = { ...DEFAULT_CONFIG, ...config };
  let running = true;
  let currentRun: Promise<void> | null = null;

  await initializeSleepDb(root);

  logger.info('Sleep agent starting', {
    interval: `${cfg.intervalMinutes}m`,
    batchSize: cfg.batchSize,
  });

  const runCycle = async (): Promise<void> => {
    if (!running) return;

    // Wait for any active storeConversation to finish before starting cycle
    // Concurrent access between sleep agent and storeConversation causes OOM
    try {
      const { isStoreActive } = await import('../store-conversation.js');
      if (isStoreActive()) {
        logger.info('Waiting for active storeConversation to finish before sleep cycle');
        // Poll every 2 seconds until store is done (max 60 seconds)
        for (let i = 0; i < 30 && isStoreActive(); i++) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    } catch {
      // import might fail in some contexts — proceed anyway
    }

    const db = getSleepDb(root);
    const startTime = Date.now();

    const runResult = db.prepare(`
      INSERT INTO sleep_runs (started_at, status)
      VALUES (datetime('now'), 'running')
    `).run();
    const runId = runResult.lastInsertRowid as number;

    const memMB = () => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    logger.info('Sleep cycle starting', { runId, heapMB: memMB() });

    const metrics: Partial<RunMetrics> = {};

    try {
      // Step 1: Decay
      saveCheckpoint(db, runId, 'decay');
      const decayStart = Date.now();
      const decayResult = await runDecayStep(root, cfg);
      metrics.decay = { ...decayResult, durationMs: Date.now() - decayStart };
      recordTelemetry(db, runId, 'decay', metrics.decay);
      logger.info('Decay step completed', { runId, heapMB: memMB(), ...metrics.decay });

      // Step 2: Tag
      saveCheckpoint(db, runId, 'tag');
      const tagStart = Date.now();
      const tagResult = await runTagStep(root, cfg);
      metrics.tag = { ...tagResult, durationMs: Date.now() - tagStart };
      recordTelemetry(db, runId, 'tag', metrics.tag);
      logger.info('Tag step completed', { runId, heapMB: memMB(), ...metrics.tag });

      // Step 2.5: Consolidate (merge repeated timeline entries)
      saveCheckpoint(db, runId, 'consolidate');
      const consolidateStart = Date.now();
      const consolidateResult = await runConsolidateStep(root, cfg);
      metrics.consolidate = { ...consolidateResult, durationMs: Date.now() - consolidateStart };
      recordTelemetry(db, runId, 'consolidate', metrics.consolidate);
      logger.info('Consolidate step completed', { runId, heapMB: memMB(), ...metrics.consolidate });

      // Step 3: Link
      saveCheckpoint(db, runId, 'link');
      const linkStart = Date.now();
      const linkResult = await runLinkStep(root, cfg);
      metrics.link = { ...linkResult, durationMs: Date.now() - linkStart };
      recordTelemetry(db, runId, 'link', metrics.link);
      logger.info('Link step completed', { runId, heapMB: memMB(), ...metrics.link });

      // Step 4: Tier
      saveCheckpoint(db, runId, 'tier');
      const tierStart = Date.now();
      const tierResult = await runTierStep(root, cfg);
      metrics.tier = { ...tierResult, durationMs: Date.now() - tierStart };
      recordTelemetry(db, runId, 'tier', metrics.tier);
      logger.info('Tier step completed', { runId, heapMB: memMB(), ...metrics.tier });

      // Step 5: Summarize
      saveCheckpoint(db, runId, 'summarize');
      const summarizeStart = Date.now();
      const summarizeResult = await runSummarizeStep(root, cfg);
      metrics.summarize = { ...summarizeResult, durationMs: Date.now() - summarizeStart };
      recordTelemetry(db, runId, 'summarize', metrics.summarize);
      logger.info('Summarize step completed', { runId, heapMB: memMB(), ...metrics.summarize });

      // Step 5.5: Observe (extract structured observations from conversations)
      saveCheckpoint(db, runId, 'observe');
      const observeStart = Date.now();
      const observeResult = await runObserveStep(root, cfg);
      metrics.observe = { ...observeResult, durationMs: Date.now() - observeStart };
      recordTelemetry(db, runId, 'observe', metrics.observe);
      logger.info('Observe step completed', { runId, heapMB: memMB(), ...metrics.observe });

      // Step 5.6: Profile (regenerate user profile from fact store)
      saveCheckpoint(db, runId, 'profile');
      const profileStart = Date.now();
      const profileResult = await runProfileStep(root, cfg);
      metrics.profile = { ...profileResult, durationMs: Date.now() - profileStart };
      recordTelemetry(db, runId, 'profile', metrics.profile);
      logger.info('Profile step completed', { runId, heapMB: memMB(), ...metrics.profile });

      // Step 5.7: Reasoning (deduction + induction on entities with 3+ facts)
      saveCheckpoint(db, runId, 'reasoning');
      const reasoningStart = Date.now();
      const reasoningResult = await runReasoningStep(root, cfg);
      metrics.reasoning = { ...reasoningResult, durationMs: Date.now() - reasoningStart };
      recordTelemetry(db, runId, 'reasoning', metrics.reasoning);
      logger.info('Reasoning step completed', { runId, heapMB: memMB(), ...metrics.reasoning });

      // Step 6: Entity Hygiene
      saveCheckpoint(db, runId, 'entity-hygiene');
      const hygieneStart = Date.now();
      const hygieneResult = await runEntityHygieneStep(root, cfg);
      metrics.entityHygiene = { ...hygieneResult, durationMs: Date.now() - hygieneStart };
      recordTelemetry(db, runId, 'entity-hygiene', metrics.entityHygiene);
      logger.info('Entity hygiene step completed', { runId, heapMB: memMB(), ...metrics.entityHygiene });

      // Complete run
      const totalDuration = Date.now() - startTime;
      metrics.totalDurationMs = totalDuration;

      db.prepare(`
        UPDATE sleep_runs
        SET status = 'completed',
            completed_at = datetime('now'),
            metrics = ?
        WHERE id = ?
      `).run(JSON.stringify(metrics), runId);

      logger.info('Sleep cycle completed', {
        runId,
        totalDurationMs: totalDuration,
        decay: metrics.decay?.count,
        tag: metrics.tag?.count,
        consolidate: metrics.consolidate?.count,
        link: metrics.link?.count,
        tier: metrics.tier?.count,
        summarize: metrics.summarize?.count,
        observe: metrics.observe?.count,
        profile: metrics.profile?.count,
        entityHygiene: metrics.entityHygiene?.count,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Sleep cycle failed', { runId, error: errorMessage });

      db.prepare(`
        UPDATE sleep_runs
        SET status = 'failed',
            completed_at = datetime('now'),
            error_message = ?,
            metrics = ?
        WHERE id = ?
      `).run(errorMessage, JSON.stringify(metrics), runId);
    }
  };

  // Initial run after configured delay
  const initialDelay = cfg.initialDelayMinutes * 60 * 1000;
  const initialTimeout = setTimeout(() => {
    if (running) {
      currentRun = runCycle().finally(() => { currentRun = null; });
    }
  }, initialDelay);

  // Recurring runs
  const interval = setInterval(() => {
    if (running && !currentRun) {
      currentRun = runCycle().finally(() => { currentRun = null; });
    }
  }, cfg.intervalMinutes * 60 * 1000);

  return {
    stop: async () => {
      running = false;
      clearTimeout(initialTimeout);
      clearInterval(interval);
      if (currentRun) {
        logger.info('Waiting for current sleep cycle to complete...');
        await currentRun;
      }
      logger.info('Sleep agent stopped');
    },
    status: () => running ? 'running' : 'stopped',
  };
}

/**
 * Run a single sleep cycle immediately (for CLI usage).
 */
export async function runSleepCycleNow(root: string, config: Partial<SleepConfig> = {}): Promise<RunMetrics> {
  const cfg: SleepConfig = { ...DEFAULT_CONFIG, ...config };

  await initializeSleepDb(root);
  const db = getSleepDb(root);
  const startTime = Date.now();

  const runResult = db.prepare(`
    INSERT INTO sleep_runs (started_at, status)
    VALUES (datetime('now'), 'running')
  `).run();
  const runId = runResult.lastInsertRowid as number;

  try {
    saveCheckpoint(db, runId, 'decay');
    const decayStart = Date.now();
    const decayResult = await runDecayStep(root, cfg);
    const decay = { ...decayResult, durationMs: Date.now() - decayStart };
    recordTelemetry(db, runId, 'decay', decay);

    saveCheckpoint(db, runId, 'tag');
    const tagStart = Date.now();
    const tagResult = await runTagStep(root, cfg);
    const tag = { ...tagResult, durationMs: Date.now() - tagStart };
    recordTelemetry(db, runId, 'tag', tag);

    saveCheckpoint(db, runId, 'consolidate');
    const consolidateStart = Date.now();
    const consolidateResult = await runConsolidateStep(root, cfg);
    const consolidate = { ...consolidateResult, durationMs: Date.now() - consolidateStart };
    recordTelemetry(db, runId, 'consolidate', consolidate);

    saveCheckpoint(db, runId, 'link');
    const linkStart = Date.now();
    const linkResult = await runLinkStep(root, cfg);
    const link = { ...linkResult, durationMs: Date.now() - linkStart };
    recordTelemetry(db, runId, 'link', link);

    saveCheckpoint(db, runId, 'tier');
    const tierStart = Date.now();
    const tierResult = await runTierStep(root, cfg);
    const tier = { ...tierResult, durationMs: Date.now() - tierStart };
    recordTelemetry(db, runId, 'tier', tier);

    saveCheckpoint(db, runId, 'summarize');
    const summarizeStart = Date.now();
    const summarizeResult = await runSummarizeStep(root, cfg);
    const summarize = { ...summarizeResult, durationMs: Date.now() - summarizeStart };
    recordTelemetry(db, runId, 'summarize', summarize);

    saveCheckpoint(db, runId, 'observe');
    const observeStart = Date.now();
    const observeResult = await runObserveStep(root, cfg);
    const observe = { ...observeResult, durationMs: Date.now() - observeStart };
    recordTelemetry(db, runId, 'observe', observe);

    saveCheckpoint(db, runId, 'profile');
    const profileStart = Date.now();
    const profileResult = await runProfileStep(root, cfg);
    const profile = { ...profileResult, durationMs: Date.now() - profileStart };
    recordTelemetry(db, runId, 'profile', profile);

    saveCheckpoint(db, runId, 'entity-hygiene');
    const hygieneStart = Date.now();
    const hygieneResult = await runEntityHygieneStep(root, cfg);
    const entityHygiene = { ...hygieneResult, durationMs: Date.now() - hygieneStart };
    recordTelemetry(db, runId, 'entity-hygiene', entityHygiene);

    const totalDurationMs = Date.now() - startTime;
    const metrics: RunMetrics = { decay, tag, consolidate, link, tier, summarize, observe, profile, entityHygiene, totalDurationMs };

    db.prepare(`
      UPDATE sleep_runs
      SET status = 'completed',
          completed_at = datetime('now'),
          metrics = ?
      WHERE id = ?
    `).run(JSON.stringify(metrics), runId);

    return metrics;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    db.prepare(`
      UPDATE sleep_runs
      SET status = 'failed',
          completed_at = datetime('now'),
          error_message = ?
      WHERE id = ?
    `).run(errorMessage, runId);
    throw error;
  }
}

/**
 * Record step telemetry to the sleep_telemetry table.
 */
function recordTelemetry(
  db: import('../../database.js').Database,
  runId: number,
  step: string,
  result: { count: number; processed?: number; durationMs: number; errors?: string[] }
): void {
  try {
    const metadata: Record<string, unknown> = { count: result.count };
    if (result.processed !== undefined) metadata.processed = result.processed;
    if (result.errors) metadata.errors = result.errors;

    db.prepare(`
      INSERT INTO sleep_telemetry (run_id, step, event_type, count, duration_ms, metadata)
      VALUES (?, ?, 'step_completed', ?, ?, ?)
    `).run(
      runId,
      step,
      result.count,
      result.durationMs,
      JSON.stringify(metadata)
    );
  } catch {
    // Don't let telemetry failures break the cycle
  }
}
