/**
 * Tier Step
 *
 * Manages memory tiers (hot/warm/archive):
 * - Hot: High priority, recently accessed, well-connected
 * - Warm: Medium priority, moderately recent
 * - Archive: Low priority, old, poorly connected
 *
 * Queues tier-changed items for re-summarization.
 */

import Database from 'libsql';
import { createLogger } from '../../../logger.js';
import { getTimelineDb } from '../../timeline.js';
import { getSleepDb } from '../db.js';
import { SleepConfig } from '../config.js';

const logger = createLogger('sleep:tier');

type Tier = 'hot' | 'warm' | 'archive';

export interface TierResult {
  count: number;
  errors?: string[];
}

export async function runTierStep(
  root: string,
  config: SleepConfig
): Promise<TierResult> {
  const timeline = await getTimelineDb(root);
  const sleep = getSleepDb(root);
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  let changed = 0;
  const errors: string[] = [];

  try {
    const items = timeline.prepare(`
      SELECT id, source_path, priority, decay_score, tier, last_accessed, access_count, is_pinned
      FROM timeline_events
      LIMIT ?
    `).all(config.batchSize) as Array<{
      id: number;
      source_path: string;
      priority: number | null;
      decay_score: number | null;
      tier: string | null;
      last_accessed: string | null;
      access_count: number | null;
      is_pinned: number | null;
    }>;

    for (const item of items) {
      try {
        if (item.is_pinned) {
          if (item.tier !== 'hot') {
            updateTier(timeline, sleep, item.id, 'hot', item.tier as Tier | null, 'pinned');
            changed++;
          }
          continue;
        }

        // Relationship score: confidence-weighted edge count
        const edgeData = sleep.prepare(`
          SELECT COUNT(*) as count, COALESCE(SUM(confidence), 0) as totalConfidence
          FROM memory_edges
          WHERE from_path = ? OR to_path = ?
        `).get(item.source_path, item.source_path) as { count: number; totalConfidence: number };
        const relationshipScore = edgeData.totalConfidence;
        const edgeCount = edgeData.count;

        const daysSinceAccess = item.last_accessed
          ? (now - new Date(item.last_accessed + 'Z').getTime()) / DAY_MS
          : 30;

        let newTier: Tier;
        const priority = item.priority ?? 0.5;
        const decayScore = item.decay_score ?? 0;

        if (
          priority >= config.hotPriorityThreshold ||
          decayScore <= config.hotDecayThreshold ||
          daysSinceAccess <= config.hotAccessDays ||
          relationshipScore >= config.hotEdgeCount ||
          edgeCount >= 4
        ) {
          newTier = 'hot';
        } else if (
          priority >= config.warmPriorityThreshold ||
          daysSinceAccess <= config.warmAccessDays ||
          relationshipScore >= config.warmEdgeCount
        ) {
          newTier = 'warm';
        } else {
          newTier = 'archive';
        }

        if (newTier !== (item.tier || 'warm')) {
          // Determine reason for tier change
          let reason = 'threshold';
          if (newTier === 'hot') {
            if (priority >= config.hotPriorityThreshold) reason = 'high_priority';
            else if (decayScore <= config.hotDecayThreshold) reason = 'low_decay';
            else if (daysSinceAccess <= config.hotAccessDays) reason = 'recent_access';
            else if (relationshipScore >= config.hotEdgeCount) reason = 'high_relationships';
          } else if (newTier === 'archive') {
            reason = 'low_activity';
          }
          updateTier(timeline, sleep, item.id, newTier, (item.tier || 'warm') as Tier, reason);
          changed++;
        }
      } catch (error) {
        errors.push(`Failed to tier item ${item.id}: ${error}`);
      }
    }

    logger.debug('Tier step completed', { processed: items.length, changed });
  } catch (error) {
    logger.error('Tier step failed', { error: String(error) });
    errors.push(`Tier step failed: ${error}`);
  }

  return { count: changed, errors: errors.length > 0 ? errors : undefined };
}

function updateTier(
  timeline: Database.Database,
  sleep: Database.Database,
  itemId: number,
  newTier: Tier,
  oldTier: Tier | null,
  reason?: string
): void {
  timeline.prepare(`
    UPDATE timeline_events SET tier = ? WHERE id = ?
  `).run(newTier, itemId);

  // Queue for re-summarization (AI will generate tier-appropriate summary)
  sleep.prepare(`
    INSERT OR REPLACE INTO maintenance_queue
    (item_type, item_id, task, priority, created_at)
    VALUES ('timeline', ?, 'resummarize', ?, datetime('now'))
  `).run(
    itemId.toString(),
    newTier === 'hot' ? 2 : newTier === 'warm' ? 1 : 0
  );

  // Log tier transition for debugging and analytics
  try {
    sleep.exec(`
      CREATE TABLE IF NOT EXISTS tier_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        from_tier TEXT,
        to_tier TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    sleep.prepare(`
      INSERT INTO tier_transitions (item_id, from_tier, to_tier, reason)
      VALUES (?, ?, ?, ?)
    `).run(itemId, oldTier, newTier, reason || 'threshold');
  } catch {
    // Non-critical, don't fail the step
  }

  logger.debug('Tier changed', { itemId, from: oldTier, to: newTier, reason });
}
