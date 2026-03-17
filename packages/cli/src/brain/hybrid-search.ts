/**
 * KyberBot — Hybrid Search
 *
 * Combines semantic search (ChromaDB) with keyword search (SQLite FTS5).
 * Weighting: 70% semantic + 30% metadata (configurable).
 */

import { createLogger } from '../logger.js';
import { getRoot } from '../config.js';
import { semanticSearch, SearchResult } from './embeddings.js';
import { getTimelineDb } from './timeline.js';
import { getSleepDb } from './sleep/db.js';

const logger = createLogger('hybrid-search');

/** Strip /seg_N suffix to get the parent conversation path */
function getParentPath(sourcePath: string): string {
  return sourcePath.replace(/\/seg_\d+$/, '');
}

export interface HybridSearchResult {
  id: string;
  title: string;
  content: string;
  source_path: string;
  timestamp: string;
  type: string;
  tier?: string;
  priority?: number;
  tags?: string[];
  semanticScore: number;
  metadataScore: number;
  hybridScore: number;
  matchType: 'semantic' | 'keyword' | 'both';
  relatedMemories?: string[];
}

export interface HybridSearchOptions {
  limit?: number;
  tier?: 'hot' | 'warm' | 'archive' | 'all';
  minPriority?: number;
  includeRelated?: boolean;
  semanticWeight?: number;
  metadataWeight?: number;
  type?: 'conversation' | 'idea' | 'file' | 'transcript' | 'note';
  entity?: string;
  entityMatch?: 'all' | 'any';
  after?: Date;
  before?: Date;
}

export async function hybridSearch(
  query: string,
  rootDir?: string,
  options: HybridSearchOptions = {}
): Promise<HybridSearchResult[]> {
  const root = rootDir || getRoot();
  const {
    limit = 20,
    tier = 'all',
    minPriority = 0,
    includeRelated = true,
    semanticWeight = 0.7,
    metadataWeight = 0.3,
    type,
    entity,
    entityMatch = 'all',
    after,
    before,
  } = options;

  logger.debug('Hybrid search starting', { query, tier, limit });

  // Run both searches in parallel
  const [semanticResults, metadataResults] = await Promise.all([
    semanticSearch(query, { limit: limit * 3, type }).catch((err) => {
      logger.debug('Semantic search unavailable, using keyword only', { error: String(err) });
      return [] as SearchResult[];
    }),
    metadataSearch(query, root, { limit: limit * 3 }),
  ]);

  // Normalize scores
  const maxSemantic = Math.max(...semanticResults.map(r => 1 - r.distance), 0.001);
  const maxMetadata = Math.max(...metadataResults.map(r => r.score), 0.001);

  // Merge results - group by parent path, keep best 3 segments per conversation
  const MAX_SEGMENTS_PER_PARENT = 3;
  const merged = new Map<string, HybridSearchResult>();

  // Track segments per parent path to allow multiple high-quality segments
  const parentSegments = new Map<string, Array<{ sourcePath: string; score: number }>>();

  for (const r of semanticResults) {
    const normalizedScore = (1 - r.distance) / maxSemantic;
    const parentPath = getParentPath(r.metadata.source_path);
    const segments = parentSegments.get(parentPath) || [];

    // Check if we should include this segment
    if (segments.length < MAX_SEGMENTS_PER_PARENT) {
      segments.push({ sourcePath: r.metadata.source_path, score: normalizedScore });
      parentSegments.set(parentPath, segments);
    } else {
      // Replace the weakest segment if this one is better
      const weakestIdx = segments.reduce((minIdx, seg, idx, arr) =>
        seg.score < arr[minIdx].score ? idx : minIdx, 0);
      if (normalizedScore > segments[weakestIdx].score) {
        // Remove the old weakest entry from merged
        merged.delete(segments[weakestIdx].sourcePath);
        segments[weakestIdx] = { sourcePath: r.metadata.source_path, score: normalizedScore };
      } else {
        continue; // Skip this segment, it's weaker than all existing ones
      }
    }

    const existing = merged.get(r.metadata.source_path);
    if (!existing || normalizedScore > existing.semanticScore) {
      merged.set(r.metadata.source_path, {
        id: r.id,
        title: r.metadata.title || 'Untitled',
        content: existing ? (normalizedScore > existing.semanticScore ? r.content : existing.content) : r.content,
        source_path: r.metadata.source_path,
        timestamp: r.metadata.timestamp,
        type: r.metadata.type,
        semanticScore: normalizedScore,
        metadataScore: existing?.metadataScore || 0,
        hybridScore: normalizedScore * semanticWeight + (existing?.metadataScore || 0) * metadataWeight,
        matchType: existing?.metadataScore ? 'both' : 'semantic',
      });
    }
  }

  for (const r of metadataResults) {
    const normalizedScore = r.score / maxMetadata;
    const parentPath = getParentPath(r.source_path);

    // Try to match against existing entries: exact path first, then any segment of same parent
    let existing = merged.get(r.source_path);
    if (!existing) {
      // Check if any segment of this parent conversation is already in merged
      for (const [key, val] of merged) {
        if (getParentPath(key) === parentPath) {
          existing = val;
          break;
        }
      }
    }

    if (existing) {
      existing.metadataScore = Math.max(existing.metadataScore, normalizedScore);
      existing.hybridScore = existing.semanticScore * semanticWeight + existing.metadataScore * metadataWeight;
      existing.matchType = existing.semanticScore > 0 ? 'both' : 'keyword';
      existing.tier = r.tier;
      existing.priority = r.priority;
      existing.tags = r.tags;
    } else {
      merged.set(r.source_path, {
        id: r.id?.toString() || r.source_path,
        title: r.title,
        content: r.summary || '',
        source_path: r.source_path,
        timestamp: r.timestamp,
        type: r.type,
        tier: r.tier,
        priority: r.priority,
        tags: r.tags,
        semanticScore: 0,
        metadataScore: normalizedScore,
        hybridScore: normalizedScore * metadataWeight,
        matchType: 'keyword',
      });
    }
  }

  // Enrich semantic-only results with tier/priority/tags from timeline
  await enrichResults(merged, root);

  // Apply filters and sort
  let results = Array.from(merged.values())
    .filter(r => {
      // Tier filter
      if (tier !== 'all' && r.tier && r.tier !== tier) return false;
      // Priority filter
      if (r.priority !== undefined && r.priority < minPriority) return false;
      // Type filter (for keyword-only results not already filtered)
      if (type && r.type !== type) return false;
      // Entity filter
      if (entity) {
        const targets = entity.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
        const resultTags = (r.tags || []).map(t => t.toLowerCase());
        const titleLower = r.title.toLowerCase();
        const contentLower = r.content.toLowerCase();

        const entityMatches = targets.map(target =>
          resultTags.some(t => t.includes(target)) ||
          titleLower.includes(target) ||
          contentLower.includes(target)
        );

        if (entityMatch === 'all' && !entityMatches.every(Boolean)) return false;
        if (entityMatch === 'any' && !entityMatches.some(Boolean)) return false;
      }
      // Time filters
      if (after || before) {
        const ts = new Date(r.timestamp);
        if (after && ts < after) return false;
        if (before && ts > before) return false;
      }
      return true;
    })
    .sort((a, b) => b.hybridScore - a.hybridScore)
    .slice(0, limit);

  // Add related memories from sleep agent edges
  if (includeRelated && results.length > 0) {
    results = addRelatedMemories(results, root);
  }

  logger.debug('Hybrid search completed', {
    semanticCount: semanticResults.length,
    metadataCount: metadataResults.length,
    mergedCount: merged.size,
    resultCount: results.length,
  });

  return results;
}

interface MetadataResult {
  id: number;
  source_path: string;
  title: string;
  summary: string;
  type: string;
  timestamp: string;
  tier: string;
  priority: number;
  tags: string[];
  score: number;
}

async function metadataSearch(
  query: string,
  root: string,
  options: { limit: number }
): Promise<MetadataResult[]> {
  const timeline = await getTimelineDb(root);

  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= 3);

  if (words.length === 0) return [];

  // Use FTS5 for initial candidates
  const ftsQuery = words.join(' OR ');

  let candidates: Array<{
    id: number;
    source_path: string;
    title: string;
    summary: string;
    type: string;
    timestamp: string;
    tier: string | null;
    priority: number | null;
    tags_json: string | null;
  }>;

  try {
    candidates = timeline.prepare(`
      SELECT t.id, t.source_path, t.title, t.summary, t.type, t.timestamp,
             t.tier, t.priority, t.tags_json
      FROM timeline_events t
      JOIN timeline_fts fts ON t.id = fts.rowid
      WHERE timeline_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, options.limit) as typeof candidates;
  } catch {
    // FTS query might fail with special characters
    candidates = [];
  }

  // Score each result
  return candidates.map(r => {
    let score = 0;
    const titleLower = (r.title || '').toLowerCase();
    const summaryLower = (r.summary || '').toLowerCase();
    const parsedTags = JSON.parse(r.tags_json || '[]');
    const tags: string[] = (Array.isArray(parsedTags) ? parsedTags :
      (typeof parsedTags === 'string' ? parsedTags.split(',').map((s: string) => s.trim()) : [])
    ).map((t: string) => t.toLowerCase());

    for (const word of words) {
      // Title matching (highest signal)
      if (titleLower === word) score += 10;
      else if (titleLower.includes(word)) score += 5;

      // Tag matching (sleep agent enriched - strong signal)
      if (tags.includes(word)) score += 8;
      else if (tags.some(t => t.includes(word))) score += 4;

      // Summary matching
      if (summaryLower.includes(word)) score += 2;
    }

    // Priority boost from sleep agent decay
    score *= 1 + (r.priority || 0.5);

    // Tier boost: hot items are more relevant
    if (r.tier === 'hot') score *= 1.2;
    else if (r.tier === 'warm') score *= 1.0;
    else if (r.tier === 'archive') score *= 0.8;

    return {
      id: r.id,
      source_path: r.source_path,
      title: r.title,
      summary: r.summary,
      type: r.type,
      timestamp: r.timestamp,
      tier: r.tier || 'warm',
      priority: r.priority || 0.5,
      tags,
      score,
    };
  }).sort((a, b) => b.score - a.score);
}

async function enrichResults(
  merged: Map<string, HybridSearchResult>,
  root: string
): Promise<void> {
  // Fill in tier/priority/tags for results missing this data (semantic-only matches)
  const needsEnrichment = Array.from(merged.values()).filter(r => !r.tier || !r.tags);
  if (needsEnrichment.length === 0) return;

  try {
    const timeline = await getTimelineDb(root);

    for (const result of needsEnrichment) {
      const row = timeline.prepare(`
        SELECT tier, priority, tags_json, entities_json
        FROM timeline_events
        WHERE source_path = ?
      `).get(result.source_path) as {
        tier: string | null;
        priority: number | null;
        tags_json: string | null;
        entities_json: string | null;
      } | undefined;

      if (row) {
        result.tier = row.tier || 'warm';
        result.priority = row.priority ?? 0.5;

        const parsed = JSON.parse(row.tags_json || '[]');
        result.tags = Array.isArray(parsed) ? parsed :
          (typeof parsed === 'string' ? parsed.split(',').map((s: string) => s.trim()).filter(Boolean) : []);

        // Apply priority boost to hybrid score
        result.hybridScore *= 1 + (result.priority || 0.5);

        // Tier boost
        if (result.tier === 'hot') result.hybridScore *= 1.2;
        else if (result.tier === 'archive') result.hybridScore *= 0.8;
      }
    }
  } catch (error) {
    logger.debug('Failed to enrich results', { error: String(error) });
  }
}

function addRelatedMemories(
  results: HybridSearchResult[],
  root: string
): HybridSearchResult[] {
  let sleep: import('better-sqlite3').Database;
  try {
    sleep = getSleepDb(root);
  } catch {
    return results;
  }

  for (const result of results) {
    try {
      const related = sleep.prepare(`
        SELECT
          CASE WHEN from_path = ? THEN to_path ELSE from_path END as related_path,
          confidence
        FROM memory_edges
        WHERE from_path = ? OR to_path = ?
        ORDER BY confidence DESC
        LIMIT 3
      `).all(result.source_path, result.source_path, result.source_path) as Array<{
        related_path: string;
        confidence: number;
      }>;

      if (related.length > 0) {
        result.relatedMemories = related.map(r => r.related_path);
      }
    } catch {
      // Ignore errors fetching related memories
    }
  }

  return results;
}
