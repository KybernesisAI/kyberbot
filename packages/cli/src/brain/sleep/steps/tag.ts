/**
 * Tag Step
 *
 * Refreshes stale or missing tags using AI:
 * - Identifies items with tags older than configured days or no tags
 * - Generates new tags using Claude
 * - Merges with existing topics (deduplication)
 * - Limited to maxTagsPerRun to control API costs
 */

import { getClaudeClient } from '../../../claude.js';
import { createLogger } from '../../../logger.js';
import { getTimelineDb } from '../../timeline.js';
import { SleepConfig } from '../config.js';
import { withRetry } from '../../../utils/retry.js';
import * as fs from 'fs/promises';

const logger = createLogger('sleep:tag');

export interface TagResult {
  count: number;
  errors?: string[];
}

export async function runTagStep(
  root: string,
  config: SleepConfig
): Promise<TagResult> {
  if (!config.enableTagging) {
    return { count: 0 };
  }

  const db = await getTimelineDb(root);
  const staleDate = new Date(Date.now() - config.tagStaleDays * 24 * 60 * 60 * 1000).toISOString();
  let tagged = 0;
  const errors: string[] = [];

  try {
    const items = db.prepare(`
      SELECT id, source_path, title, summary, tags_json, topics_json
      FROM timeline_events
      WHERE (last_enriched IS NULL OR last_enriched < ?)
         OR (tags_json IS NULL OR tags_json = '[]')
      ORDER BY priority DESC
      LIMIT ?
    `).all(staleDate, config.maxTagsPerRun) as Array<{
      id: number;
      source_path: string;
      title: string | null;
      summary: string | null;
      tags_json: string | null;
      topics_json: string | null;
    }>;

    if (items.length === 0) {
      logger.debug('No items need tagging');
      return { count: 0 };
    }

    const claude = getClaudeClient();

    for (const item of items) {
      try {
        let content = item.summary || item.title || '';
        try {
          const fileContent = await fs.readFile(item.source_path, 'utf-8');
          content = fileContent.slice(0, 3000);
        } catch {
          // Use summary if file not readable
        }

        if (!content || content.length < 50) continue;

        const responseText = await withRetry(
          () => claude.complete(
            `Generate 3-7 relevant tags for this content. Return only a JSON array of lowercase strings, no explanation.

Content:
${content}

Example response: ["meeting", "pricing", "strategy", "planning"]`,
            { model: 'haiku', maxTokens: 500, subprocess: true }
          ),
          {
            retries: 2,
            delay: 2000,
            onRetry: (err, attempt) => {
              logger.warn(`Tag API retry ${attempt}/2 for item ${item.id}: ${err.message}`);
            },
          }
        );

        // Extract JSON array from response (handle potential markdown wrapping)
        const jsonMatch = responseText.match(/\[[\s\S]*?\]/);
        if (!jsonMatch) continue;

        const tags = JSON.parse(jsonMatch[0]);

        if (Array.isArray(tags) && tags.length > 0) {
          const rawTopics = JSON.parse(item.topics_json || '[]');
          const existingTopics: string[] = Array.isArray(rawTopics) ? rawTopics : [];
          const allTags = [...new Set([...tags.map((t: string) => t.toLowerCase()), ...existingTopics.map(t => t.toLowerCase())])];

          db.prepare(`
            UPDATE timeline_events
            SET tags_json = ?, last_enriched = datetime('now')
            WHERE id = ?
          `).run(JSON.stringify(allTags), item.id);
          tagged++;
        }
      } catch (error) {
        errors.push(`Failed to tag item ${item.id}: ${error}`);
      }
    }

    logger.debug('Tag step completed', { processed: items.length, tagged });
  } catch (error) {
    logger.error('Tag step failed', { error: String(error) });
    errors.push(`Tag step failed: ${error}`);
  }

  return { count: tagged, errors: errors.length > 0 ? errors : undefined };
}
