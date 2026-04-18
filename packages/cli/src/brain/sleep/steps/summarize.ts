/**
 * Summarize Step
 *
 * AI-powered summary generation:
 * - Generates tier-appropriate summaries (rich for hot, compressed for archive)
 * - Includes context: tags, entities, relationships
 * - Triggers on: tier change, new items without summaries, stale summaries
 * - Limited per run to control API costs
 */

import { getClaudeClient } from '../../../claude.js';
import { createLogger } from '../../../logger.js';
import { getTimelineDb } from '../../timeline.js';
import { getSleepDb } from '../db.js';
import { SleepConfig } from '../config.js';
import { withRetry } from '../../../utils/retry.js';
import * as fs from 'fs/promises';

const logger = createLogger('sleep:summarize');

export interface SummarizeResult {
  count: number;
  durationMs?: number;
  errors?: string[];
}

export async function runSummarizeStep(
  root: string,
  config: SleepConfig
): Promise<SummarizeResult> {
  const timeline = await getTimelineDb(root);
  const sleep = getSleepDb(root);
  let summarized = 0;
  const errors: string[] = [];
  const startTime = Date.now();

  try {
    // Phase 1: Process tier-changed items from maintenance queue
    const pendingItems = sleep.prepare(`
      SELECT id as queue_id, item_id
      FROM maintenance_queue
      WHERE task = 'resummarize' AND processed_at IS NULL
      ORDER BY priority DESC
      LIMIT ?
    `).all(config.maxSummariesPerRun) as Array<{ queue_id: number; item_id: string }>;

    // Phase 2: Find items that need summaries
    // - Never summarized or very short
    // - Raw content stored as summary (JSON blobs, full markdown files)
    const remaining = config.maxSummariesPerRun - pendingItems.length;
    const needsSummary = remaining > 0 ? timeline.prepare(`
      SELECT id FROM timeline_events
      WHERE summary IS NULL
         OR length(summary) < 50
         OR summary LIKE '{%'
         OR summary LIKE '# %'
         OR length(summary) > 500
      ORDER BY priority DESC
      LIMIT ?
    `).all(remaining) as Array<{ id: number }> : [];

    // Combine both sources
    const allItemIds = new Set<string>();
    const queueMap = new Map<string, number>(); // item_id -> queue_id

    for (const p of pendingItems) {
      allItemIds.add(p.item_id);
      queueMap.set(p.item_id, p.queue_id);
    }
    for (const n of needsSummary) {
      allItemIds.add(n.id.toString());
    }

    if (allItemIds.size === 0) {
      logger.debug('No items need summarization');
      return { count: 0 };
    }

    const claude = getClaudeClient();

    for (const itemId of allItemIds) {
      try {
        const item = timeline.prepare(`
          SELECT id, source_path, title, tier, summary, tags_json, entities_json
          FROM timeline_events WHERE id = ?
        `).get(parseInt(itemId)) as {
          id: number;
          source_path: string;
          title: string | null;
          tier: string | null;
          summary: string | null;
          tags_json: string | null;
          entities_json: string | null;
        } | undefined;

        if (!item) {
          if (queueMap.has(itemId)) markProcessed(sleep, queueMap.get(itemId)!);
          continue;
        }

        // Read source content — file paths or channel:// virtual paths
        let content = '';
        if (item.source_path.startsWith('channel://')) {
          // Virtual path: use the title + existing summary as content
          // Conversations store truncated response as summary at ingestion
          const parts: string[] = [];
          if (item.title) parts.push(item.title);
          if (item.summary && item.summary.length > 10) parts.push(item.summary);
          content = parts.join('\n\n').slice(0, 4000);
        } else {
          try {
            const raw = await fs.readFile(item.source_path, 'utf-8');
            // Strip frontmatter and limit to 4000 chars for cost control
            content = raw.replace(/^---[\s\S]*?---\n*/m, '').slice(0, 4000);
          } catch {
            if (queueMap.has(itemId)) markProcessed(sleep, queueMap.get(itemId)!);
            continue;
          }
        }

        if (content.length < 20) {
          if (queueMap.has(itemId)) markProcessed(sleep, queueMap.get(itemId)!);
          continue;
        }

        // Gather context
        const tags = safeParseArray(item.tags_json);
        const entities = safeParseArray(item.entities_json);

        // Get related memories for context
        const edges = sleep.prepare(`
          SELECT
            CASE WHEN from_path = ? THEN to_path ELSE from_path END as related_path,
            shared_tags
          FROM memory_edges
          WHERE from_path = ? OR to_path = ?
          LIMIT 3
        `).all(item.source_path, item.source_path, item.source_path) as Array<{
          related_path: string;
          shared_tags: string;
        }>;

        const relatedTitles: string[] = [];
        for (const edge of edges) {
          const related = timeline.prepare(
            `SELECT title FROM timeline_events WHERE source_path = ?`
          ).get(edge.related_path) as { title: string } | undefined;
          if (related?.title) relatedTitles.push(related.title);
        }

        // Build tier-appropriate prompt
        const prompt = buildSummaryPrompt(
          content,
          item.tier || 'warm',
          item.title,
          tags,
          entities,
          relatedTitles
        );

        const responseText = await withRetry(
          () => claude.complete(prompt, { model: 'haiku', maxTokens: 300, subprocess: true }),
          {
            retries: 2,
            delay: 2000,
            onRetry: (err, attempt) => {
              logger.warn(`Summary API retry ${attempt}/2 for item ${itemId}: ${err.message}`);
            },
          }
        );

        // Strip common LLM preambles and meta-commentary
        const newSummary = responseText
          .replace(/^(Here's|Here is|Summary|Archived Memory Summary|Memory Archive|Summary for Personal Knowledge System)[:\s]*/i, '')
          .replace(/^(the |a )?(ultra-concise|concise|brief|compressed|detailed|rich)?,? ?(detailed )?summary[:\s]*(for (the )?personal knowledge system)?[:\s]*(in third person,? ?(past tense)?[.:\s]*)?/i, '')
          .replace(/^of\s+(?=[A-Z])/m, '')  // "of Title..." leftover
          .replace(/^for Personal Knowledge System[:\s]*/i, '')
          .trim();

        if (newSummary && newSummary.length > 20) {
          timeline.prepare(`
            UPDATE timeline_events
            SET summary = ?, last_enriched = datetime('now')
            WHERE id = ?
          `).run(newSummary, item.id);
          summarized++;
        }

        if (queueMap.has(itemId)) markProcessed(sleep, queueMap.get(itemId)!);
      } catch (error) {
        const errMsg = `Failed to summarize item ${itemId}: ${error}`;
        errors.push(errMsg);
        if (queueMap.has(itemId)) {
          sleep.prepare(`
            UPDATE maintenance_queue
            SET processed_at = datetime('now'), error_message = ?
            WHERE id = ?
          `).run(String(error), queueMap.get(itemId)!);
        }
      }
    }

    logger.debug('Summarize step completed', {
      queued: pendingItems.length,
      needsSummary: needsSummary.length,
      summarized,
    });
  } catch (error) {
    logger.error('Summarize step failed', { error: String(error) });
    errors.push(`Summarize step failed: ${error}`);
  }

  return {
    count: summarized,
    durationMs: Date.now() - startTime,
    errors: errors.length > 0 ? errors : undefined,
  };
}

function buildSummaryPrompt(
  content: string,
  tier: string,
  title: string | null,
  tags: string[],
  entities: string[],
  relatedTitles: string[]
): string {
  const context: string[] = [];
  if (title) context.push(`Title: ${title}`);
  if (tags.length > 0) context.push(`Tags: ${tags.join(', ')}`);
  if (entities.length > 0) context.push(`People/entities mentioned: ${entities.join(', ')}`);
  if (relatedTitles.length > 0) context.push(`Related memories: ${relatedTitles.join(', ')}`);

  const contextBlock = context.length > 0
    ? `\nContext:\n${context.join('\n')}\n`
    : '';

  if (tier === 'hot') {
    return `Summarize this content for a personal knowledge system. This is a HIGH-PRIORITY memory that is frequently accessed. Write a rich, detailed summary (3-5 sentences) that captures:
- The key topic and what was discussed/decided
- Who was involved (if anyone mentioned)
- Any action items, decisions, or insights
- Why this matters (context/significance)

Write in third person, past tense. Be specific and factual, not generic.
${contextBlock}
Content:
${content}`;
  }

  if (tier === 'archive') {
    return `Summarize this content for a personal knowledge system. This is an ARCHIVED memory (low priority, rarely accessed). Write a compressed summary (1-2 sentences) that captures only the core essence — what it was about and one key detail.

Write in third person, past tense. Be ultra-concise.
${contextBlock}
Content:
${content}`;
  }

  // warm (default)
  return `Summarize this content for a personal knowledge system. Write a clear summary (2-3 sentences) that captures:
- The main topic
- Key points or decisions
- Who was involved (if relevant)

Write in third person, past tense. Be specific and factual.
${contextBlock}
Content:
${content}`;
}

function markProcessed(db: import('libsql').Database, queueId: number): void {
  db.prepare(`
    UPDATE maintenance_queue SET processed_at = datetime('now') WHERE id = ?
  `).run(queueId);
}

function safeParseArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') return parsed.split(',').map(s => s.trim()).filter(Boolean);
    return [];
  } catch {
    return [];
  }
}
