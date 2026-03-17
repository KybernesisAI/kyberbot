/**
 * Link Step
 *
 * Builds relationships between memories based on shared tags:
 * - Calculates Jaccard similarity between tag sets
 * - Creates edges for pairs with similarity >= threshold
 * - Stores bidirectional relationships in memory_edges
 * - Respects maxEdgesPerMemory cap
 */

import { createLogger } from '../../../logger.js';
import { getTimelineDb } from '../../timeline.js';
import { getSleepDb } from '../db.js';
import { SleepConfig } from '../config.js';
import { jaccardSimilarity } from '../utils/jaccard.js';

const logger = createLogger('sleep:link');

export interface LinkResult {
  count: number;
  processed: number;
  errors?: string[];
}

function safeParseArray(json: string | null): string[] {
  if (!json) return [];
  try { return JSON.parse(json); } catch { return []; }
}

/**
 * Determine the semantic relation type between two timeline items
 * based on shared context.
 */
function determineRelationType(
  item: { source_path: string; title: string; entities_json: string | null },
  other: { source_path: string; title: string; entities_json: string | null },
  sharedTags: Set<string>
): string {
  const itemEntities = safeParseArray(item.entities_json);
  const otherEntities = safeParseArray(other.entities_json);

  // Check for shared person/company entities
  if (itemEntities.length > 0 && otherEntities.length > 0) {
    const shared = itemEntities.filter(e =>
      otherEntities.some(o => o.toLowerCase() === e.toLowerCase())
    );
    if (shared.length > 0) return 'same_person';
  }

  // Check for continuation (same channel)
  const itemChannel = item.source_path.match(/^channel:\/\/(\w+)\//)?.[1];
  const otherChannel = other.source_path.match(/^channel:\/\/(\w+)\//)?.[1];
  if (itemChannel && itemChannel === otherChannel) return 'continuation';

  // Check for topic overlap (>= 2 shared content tags)
  if (sharedTags.size >= 2) return 'same_topic';

  // Check for reference (one title contains the other)
  const itemTitle = item.title.replace(/^\[.*?\]\s*/, '').toLowerCase();
  const otherTitle = other.title.replace(/^\[.*?\]\s*/, '').toLowerCase();
  if (itemTitle.length >= 4 && otherTitle.length >= 4) {
    if (itemTitle.includes(otherTitle) || otherTitle.includes(itemTitle)) {
      return 'referenced';
    }
  }

  return 'related';
}

export async function runLinkStep(
  root: string,
  config: SleepConfig
): Promise<LinkResult> {
  const timeline = await getTimelineDb(root);
  const sleep = getSleepDb(root);
  let created = 0;
  const errors: string[] = [];

  // Metadata/generic tags to exclude from similarity (noise, not semantic)
  const EXCLUDED_TAGS = new Set([
    'pdf', 'upload', 'connector', 'note', 'file', 'document', 'markdown',
    'conversation', 'transcript', 'idea', 'json', 'text', 'audio',
  ]);

  try {
    const items = timeline.prepare(`
      SELECT id, source_path, title, tier, tags_json, topics_json, entities_json
      FROM timeline_events
      WHERE (tags_json IS NOT NULL AND tags_json != '[]')
         OR (topics_json IS NOT NULL AND topics_json != '[]')
      ORDER BY priority DESC
      LIMIT ?
    `).all(config.batchSize) as Array<{
      id: number;
      source_path: string;
      title: string;
      tier: string | null;
      tags_json: string | null;
      topics_json: string | null;
      entities_json: string | null;
    }>;

    if (items.length < 2) {
      logger.debug('Not enough items with tags for linking');
      return { count: 0, processed: 0 };
    }

    // Build lookup map from source_path to item data (for determineRelationType)
    const itemLookup = new Map<string, { source_path: string; title: string; entities_json: string | null }>();
    for (const item of items) {
      itemLookup.set(item.source_path, { source_path: item.source_path, title: item.title, entities_json: item.entities_json });
    }

    // Parse tags for each item (excluding metadata tags)
    const itemTags = new Map<string, Set<string>>();
    const itemTiers = new Map<string, string>();
    for (const item of items) {
      const parsedTags = JSON.parse(item.tags_json || '[]');
      const parsedTopics = JSON.parse(item.topics_json || '[]');

      const tagList: string[] = Array.isArray(parsedTags) ? parsedTags :
        (typeof parsedTags === 'string' ? parsedTags.split(',').map((s: string) => s.trim()).filter(Boolean) : []);
      const topicList: string[] = Array.isArray(parsedTopics) ? parsedTopics :
        (typeof parsedTopics === 'string' ? parsedTopics.split(',').map((s: string) => s.trim()).filter(Boolean) : []);

      const tags = new Set<string>(
        [...tagList, ...topicList]
          .map((t: string) => t.toLowerCase())
          .filter(t => !EXCLUDED_TAGS.has(t) && t.length > 2)
      );
      if (tags.size > 0) {
        itemTags.set(item.source_path, tags);
        itemTiers.set(item.source_path, item.tier || 'warm');
      }
    }

    // Build inverted index: tag -> [paths]
    const tagIndex = new Map<string, string[]>();
    for (const [path, tags] of itemTags) {
      for (const tag of tags) {
        if (!tagIndex.has(tag)) tagIndex.set(tag, []);
        tagIndex.get(tag)!.push(path);
      }
    }

    // Find candidate pairs
    const seen = new Set<string>();

    for (const item of items) {
      const tags = itemTags.get(item.source_path);
      if (!tags || tags.size === 0) continue;

      // Check current edge count
      const edgeCount = (sleep.prepare(`
        SELECT COUNT(*) as count FROM memory_edges
        WHERE from_path = ? OR to_path = ?
      `).get(item.source_path, item.source_path) as { count: number })?.count || 0;

      if (edgeCount >= config.maxEdgesPerMemory) continue;

      // Find candidates sharing tags
      const candidates = new Map<string, Set<string>>();
      for (const tag of tags) {
        for (const otherPath of tagIndex.get(tag) || []) {
          if (otherPath === item.source_path) continue;
          if (!candidates.has(otherPath)) candidates.set(otherPath, new Set());
          candidates.get(otherPath)!.add(tag);
        }
      }

      let itemEdgesCreated = 0;
      for (const [otherPath, sharedTags] of candidates) {
        if (edgeCount + itemEdgesCreated >= config.maxEdgesPerMemory) break;
        const pairKey = [item.source_path, otherPath].sort().join('|');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        // Also check the target's edge count against the limit
        const otherEdgeCount = (sleep.prepare(`
          SELECT COUNT(*) as count FROM memory_edges
          WHERE from_path = ? OR to_path = ?
        `).get(otherPath, otherPath) as { count: number })?.count || 0;
        if (otherEdgeCount >= config.maxEdgesPerMemory) continue;

        // Skip if edge already exists
        const existing = sleep.prepare(`
          SELECT id FROM memory_edges
          WHERE (from_path = ? AND to_path = ?) OR (from_path = ? AND to_path = ?)
        `).get(item.source_path, otherPath, otherPath, item.source_path);
        if (existing) continue;

        const otherTags = itemTags.get(otherPath);
        if (!otherTags) continue;

        let confidence = jaccardSimilarity(tags, otherTags);

        // Confidence boosts
        // Same source directory = likely related content
        const sourceDir = item.source_path.split('/').slice(0, -1).join('/');
        const otherDir = otherPath.split('/').slice(0, -1).join('/');
        if (sourceDir === otherDir) confidence += 0.15;

        // Shared content tags boost (beyond basic Jaccard threshold)
        if (sharedTags.size >= 3) confidence += 0.2;
        else if (sharedTags.size >= 2) confidence += 0.1;

        // Same tier boost
        const itemTier = itemTiers.get(item.source_path);
        const otherTier = itemTiers.get(otherPath);
        if (itemTier && itemTier === otherTier) confidence += 0.05;

        // Cap at 1.0
        confidence = Math.min(1.0, confidence);

        if (confidence >= config.minConfidenceForLink) {
          const sharedTagsList = [...sharedTags];

          // Determine semantic relation type
          const otherItem = itemLookup.get(otherPath);
          const relation = otherItem
            ? determineRelationType(item, otherItem, sharedTags)
            : 'related';

          sleep.prepare(`
            INSERT INTO memory_edges
            (from_path, to_path, relation, confidence, shared_tags, rationale, method, created_at, last_verified)
            VALUES (?, ?, ?, ?, ?, ?, 'sleep-agent', datetime('now'), datetime('now'))
          `).run(
            item.source_path,
            otherPath,
            relation,
            confidence,
            JSON.stringify(sharedTagsList),
            `Jaccard: ${(jaccardSimilarity(tags, otherTags) * 100).toFixed(1)}% + boosts on: ${sharedTagsList.slice(0, 5).join(', ')}${sharedTagsList.length > 5 ? '...' : ''}`
          );
          created++;
          itemEdgesCreated++;

          if (created >= config.maxLinksPerRun) break;
        }
      }

      if (created >= config.maxLinksPerRun) break;
    }

    // Phase 2: Retype existing 'related' edges that can be more specific
    let retyped = 0;
    try {
      const untypedEdges = sleep.prepare(`
        SELECT id, from_path, to_path FROM memory_edges
        WHERE relation = 'related'
        LIMIT ?
      `).all(config.maxLinksPerRun) as Array<{ id: number; from_path: string; to_path: string }>;

      for (const edge of untypedEdges) {
        const fromItem = itemLookup.get(edge.from_path);
        const toItem = itemLookup.get(edge.to_path);
        if (!fromItem || !toItem) continue;

        const fromTags = itemTags.get(edge.from_path) || new Set<string>();
        const toTags = itemTags.get(edge.to_path) || new Set<string>();
        const shared = new Set([...fromTags].filter(t => toTags.has(t)));

        const newRelation = determineRelationType(fromItem, toItem, shared);
        if (newRelation !== 'related') {
          sleep.prepare('UPDATE memory_edges SET relation = ? WHERE id = ?').run(newRelation, edge.id);
          retyped++;
        }
      }
    } catch (retypeErr) {
      errors.push(`Edge retype failed: ${retypeErr}`);
    }

    logger.debug('Link step completed', { processed: items.length, created, retyped });
  } catch (error) {
    logger.error('Link step failed', { error: String(error) });
    errors.push(`Link step failed: ${error}`);
  }

  return { count: created + retyped, processed: created + retyped, errors: errors.length > 0 ? errors : undefined };
}
