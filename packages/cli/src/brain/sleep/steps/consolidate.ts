/**
 * KyberBot — Sleep Agent: Consolidation Step
 *
 * Merges repeated timeline entries with identical or near-identical titles
 * into a single entry. Prevents timeline bloat from heartbeat tasks and
 * other repetitive content.
 *
 * Runs between the tag and link steps.
 */

import { createLogger } from '../../../logger.js';
import { getTimelineDb } from '../../timeline.js';
import type { SleepConfig } from '../config.js';

const logger = createLogger('sleep:consolidate');

export interface ConsolidateResult {
  count: number;
  processed: number;
  errors?: string[];
}

export async function runConsolidateStep(
  root: string,
  config: SleepConfig
): Promise<ConsolidateResult> {
  if (!config.enableConsolidation) {
    return { count: 0, processed: 0 };
  }

  const db = await getTimelineDb(root);
  let consolidated = 0;
  let processed = 0;
  const errors: string[] = [];

  try {
    // Find groups of events with duplicate normalized titles
    // Strip channel prefix [xxx] and trailing ... for comparison
    const groups = db.prepare(`
      SELECT
        TRIM(REPLACE(
          CASE WHEN INSTR(title, '] ') > 0
            THEN SUBSTR(title, INSTR(title, '] ') + 2)
            ELSE title
          END,
          '...', ''
        )) as normalized_title,
        COUNT(*) as cnt,
        GROUP_CONCAT(id) as ids,
        MIN(timestamp) as first_ts,
        MAX(timestamp) as last_ts
      FROM timeline_events
      WHERE (is_pinned IS NULL OR is_pinned = 0)
      GROUP BY normalized_title
      HAVING COUNT(*) >= ?
      ORDER BY cnt DESC
      LIMIT ?
    `).all(config.consolidationTitleThreshold, config.batchSize || 50) as Array<{
      normalized_title: string;
      cnt: number;
      ids: string;
      first_ts: string;
      last_ts: string;
    }>;

    for (const group of groups) {
      processed++;
      const ids = group.ids.split(',').map(Number);

      if (ids.length < 2) continue;

      try {
        // Keep the most recent entry
        const keepId = ids[ids.length - 1];
        const removeIds = ids.slice(0, -1);

        // Sum access counts from all entries
        const removePlaceholders = removeIds.map(() => '?').join(',');
        const totalAccess = db.prepare(`
          SELECT COALESCE(SUM(COALESCE(access_count, 0)), 0) as total
          FROM timeline_events WHERE id IN (${removePlaceholders})
        `).get(...removeIds) as { total: number };

        // Update the kept entry
        db.prepare(`
          UPDATE timeline_events
          SET access_count = COALESCE(access_count, 0) + ?,
              last_accessed = datetime('now')
          WHERE id = ?
        `).run(totalAccess.total + removeIds.length, keepId);

        // Delete duplicates
        db.prepare(`
          DELETE FROM timeline_events WHERE id IN (${removePlaceholders})
        `).run(...removeIds);

        consolidated += removeIds.length;

        logger.debug('Consolidated group', {
          title: group.normalized_title,
          removed: removeIds.length,
          kept: keepId,
        });
      } catch (err) {
        errors.push(`Failed to consolidate "${group.normalized_title}": ${err}`);
      }
    }
  } catch (err) {
    errors.push(`Consolidation query failed: ${err}`);
  }

  if (consolidated > 0) {
    logger.info('Consolidation complete', { consolidated, groups: processed });
  }

  return { count: consolidated, processed, errors: errors.length > 0 ? errors : undefined };
}
