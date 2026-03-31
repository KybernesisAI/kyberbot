/**
 * Decay Step
 *
 * Applies time-based decay to memories:
 * - Older memories get higher decay scores
 * - Decay reduces priority over time
 * - Access count counteracts decay (frequently accessed = important)
 * - Pinned items are exempt from decay
 */

import { createLogger } from '../../../logger.js';
import { getTimelineDb } from '../../timeline.js';
import { ensureFactsTable } from '../../fact-store.js';
import { SleepConfig } from '../config.js';

const logger = createLogger('sleep:decay');

export interface DecayResult {
  count: number;
  processed: number;
  errors?: string[];
}

/** Detect repetitive content (heartbeat tasks, etc.) by checking title */
function isRepetitiveContent(title: string): boolean {
  const REPETITIVE_PATTERNS = [
    /heartbeat\s+task/i,
    /heartbeat-state/i,
    /check\s+posthog/i,
  ];
  return REPETITIVE_PATTERNS.some(p => p.test(title));
}

export async function runDecayStep(
  root: string,
  config: SleepConfig
): Promise<DecayResult> {
  const db = await getTimelineDb(root);
  const now = Date.now();
  let updated = 0;
  let processed = 0;
  const errors: string[] = [];

  // Sweep expired temporal facts before running decay logic
  try {
    await ensureFactsTable(root);
    const timeline = await getTimelineDb(root);
    const expired = timeline.prepare(`
      UPDATE facts SET is_latest = 0, updated_at = datetime('now')
      WHERE expires_at IS NOT NULL
        AND expires_at < datetime('now')
        AND is_latest = 1
    `).run();
    if (expired.changes > 0) {
      logger.debug(`Expired ${expired.changes} time-bound facts`);
    }
  } catch {
    // Non-fatal: facts table may not exist yet
  }

  try {
    const items = db.prepare(`
      SELECT id, title, source_path, timestamp, priority, decay_score, access_count, is_pinned
      FROM timeline_events
      WHERE tier != 'archive' OR tier IS NULL
      ORDER BY priority DESC
      LIMIT ?
    `).all(config.batchSize * 2) as Array<{
      id: number;
      title: string | null;
      source_path: string;
      timestamp: string;
      priority: number | null;
      decay_score: number | null;
      access_count: number | null;
      is_pinned: number | null;
    }>;

    processed = items.length;

    for (const item of items) {
      try {
        if (item.is_pinned) continue;

        const timestamp = new Date(item.timestamp).getTime();
        const ageHours = (now - timestamp) / (1000 * 60 * 60);

        const decayBoost = Math.min(config.maxDecay * 0.2, ageHours * config.decayRatePerHour);

        // Apply extra decay for repetitive content (heartbeat tasks, etc.)
        let effectiveDecayBoost = decayBoost;
        if (isRepetitiveContent(item.title || '') && config.repetitiveDecayMultiplier) {
          effectiveDecayBoost *= config.repetitiveDecayMultiplier;
        }

        const newDecay = Math.min(config.maxDecay, (item.decay_score || 0) + effectiveDecayBoost);

        const accessBoost = isRepetitiveContent(item.title || '')
          ? 0  // repetitive content doesn't benefit from access count
          : Math.min(0.3, (item.access_count || 0) * 0.05);
        const decayPenalty = effectiveDecayBoost / 2;
        const newPriority = Math.max(0, Math.min(1, (item.priority ?? 0.5) - decayPenalty + accessBoost));

        const decayChanged = Math.abs(newDecay - (item.decay_score || 0)) > 0.001;
        const priorityChanged = Math.abs(newPriority - (item.priority ?? 0.5)) > 0.001;

        if (decayChanged || priorityChanged) {
          db.prepare(`
            UPDATE timeline_events
            SET decay_score = ?, priority = ?
            WHERE id = ?
          `).run(newDecay, newPriority, item.id);
          updated++;
        }
      } catch (error) {
        errors.push(`Failed to decay item ${item.id}: ${error}`);
      }
    }

    logger.debug('Decay step completed', { processed: items.length, updated });
  } catch (error) {
    logger.error('Decay step failed', { error: String(error) });
    errors.push(`Decay step failed: ${error}`);
  }

  // ── Fact confidence decay (weekly) ──────────────────────────────────
  // Reduce confidence on old, unreinforced AI/chat facts so stale data fades
  try {
    await ensureFactsTable(root);
    const factsDb = await getTimelineDb(root);

    // Only run weekly — check if last decay was >7 days ago
    const lastDecay = factsDb.prepare(`
      SELECT MAX(updated_at) as last_decay FROM facts
      WHERE updated_at IS NOT NULL AND confidence < 0.85
    `).get() as { last_decay: string | null } | undefined;

    const shouldDecayFacts = !lastDecay?.last_decay ||
      (Date.now() - new Date(lastDecay.last_decay).getTime()) > 7 * 24 * 60 * 60 * 1000;

    if (shouldDecayFacts) {
      const factDecay = factsDb.prepare(`
        UPDATE facts
        SET confidence = MAX(confidence * 0.95, 0.15),
            updated_at = datetime('now')
        WHERE source_type IN ('ai-extraction', 'chat')
          AND created_at < datetime('now', '-90 days')
          AND last_reinforced_at IS NULL
          AND COALESCE(is_retracted, 0) = 0
          AND confidence > 0.15
          AND is_latest = 1
      `).run();

      if (factDecay.changes > 0) {
        logger.info(`Decayed confidence on ${factDecay.changes} old unreinforced facts`);
      }
    }
  } catch {
    // Non-fatal: facts table may not exist yet
  }

  return { count: updated, processed, errors: errors.length > 0 ? errors : undefined };
}
