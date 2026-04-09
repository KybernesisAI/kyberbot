/**
 * KyberBot — Hybrid Search
 *
 * Combines semantic search (ChromaDB) with keyword search (SQLite FTS5)
 * and temporal search (date expressions). Uses Reciprocal Rank Fusion (RRF)
 * to merge ranked lists without needing tuned weights.
 *
 * Optional Haiku-powered reranking for user-facing searches.
 */

import { createLogger } from '../logger.js';
import { getRoot } from '../config.js';
import { semanticSearch, type SearchResult } from './embeddings.js';
import { getTimelineDb } from './timeline.js';
import { getSleepDb } from './sleep/db.js';
import { getClaudeClient } from '../claude.js';

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
  semanticWeight?: number;   // kept for backwards compat — ignored (RRF used instead)
  metadataWeight?: number;   // kept for backwards compat — ignored (RRF used instead)
  type?: 'conversation' | 'idea' | 'file' | 'transcript' | 'note';
  entity?: string;
  entityMatch?: 'all' | 'any';
  after?: Date;
  before?: Date;
  expandQuery?: boolean;
  factFirst?: boolean;  // Use fact-first retrieval instead of chunk-based
  rerank?: boolean;     // default false — enable for user-facing searches
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECIPROCAL RANK FUSION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reciprocal Rank Fusion — merges multiple ranked lists without needing
 * tuned weights. Each item's score = sum(1 / (k + rank_in_list)) across
 * all lists where it appears. k=60 is standard.
 */
function reciprocalRankFusion(
  rankedLists: Array<Array<{ source_path: string; score: number; data: any }>>,
  k: number = 60
): Map<string, { rrfScore: number; data: any }> {
  const fused = new Map<string, { rrfScore: number; data: any }>();

  for (const list of rankedLists) {
    // Sort by score descending to get rank positions
    const sorted = [...list].sort((a, b) => b.score - a.score);

    for (let rank = 0; rank < sorted.length; rank++) {
      const item = sorted[rank];
      const existing = fused.get(item.source_path);
      const rrfContribution = 1 / (k + rank + 1);

      if (existing) {
        existing.rrfScore += rrfContribution;
        // Keep the data with more info (prefer semantic results which have content)
        if (item.data.content && (!existing.data.content || existing.data.content.length < item.data.content.length)) {
          existing.data = { ...existing.data, ...item.data };
        }
      } else {
        fused.set(item.source_path, {
          rrfScore: rrfContribution,
          data: item.data,
        });
      }
    }
  }

  return fused;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPORAL SEARCH CHANNEL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Temporal search channel — finds results matching date expressions in the query.
 */
async function temporalSearch(
  query: string,
  root: string,
  limit: number
): Promise<Array<{ source_path: string; score: number; data: any }>> {
  // Extract date-like terms from query
  const datePatterns = [
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi,
    /\b(20\d{2})\b/g,
    /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)/gi,
  ];

  const dateTerms: string[] = [];
  for (const pattern of datePatterns) {
    const matches = query.match(pattern);
    if (matches) dateTerms.push(...matches);
  }

  if (dateTerms.length === 0) return [];

  const timeline = await getTimelineDb(root);
  const results: Array<{ source_path: string; score: number; data: any }> = [];

  for (const term of dateTerms) {
    try {
      const rows = timeline.prepare(`
        SELECT id, title, summary, source_path, timestamp, type
        FROM timeline_events
        WHERE LOWER(title) LIKE ? OR LOWER(summary) LIKE ?
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(`%${term.toLowerCase()}%`, `%${term.toLowerCase()}%`, limit) as any[];

      for (const row of rows) {
        results.push({
          source_path: row.source_path,
          score: 1.0, // temporal matches are highly relevant
          data: {
            id: String(row.id),
            title: row.title,
            content: row.summary || '',
            source_path: row.source_path,
            timestamp: row.timestamp,
            type: row.type,
          },
        });
      }
    } catch { /* best-effort */ }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HAIKU RERANKING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Rerank search results using Claude Haiku for better precision.
 * Takes top N candidates and returns them reranked by relevance.
 */
async function haikusRerank(
  query: string,
  candidates: HybridSearchResult[],
  limit: number
): Promise<HybridSearchResult[]> {
  if (candidates.length <= 3) return candidates; // Too few to bother reranking

  // Take top 20 candidates for reranking (cost control)
  const toRerank = candidates.slice(0, Math.min(20, candidates.length));

  // Build reranking prompt
  const numbered = toRerank.map((r, i) =>
    `[${i + 1}] ${r.content.slice(0, 200)}`
  ).join('\n');

  const prompt = `Given the search query, rank these ${toRerank.length} text passages by relevance. Return ONLY a JSON array of the passage numbers in order of relevance, most relevant first. Example: [3, 1, 7, 2]

Query: "${query}"

Passages:
${numbered}

Ranking (JSON array of numbers):`;

  try {
    const client = getClaudeClient();
    const response = await client.complete(prompt, {
      model: 'haiku',
      maxTokens: 200,
      maxTurns: 1,
      subprocess: true,
    });

    const match = response.match(/\[[\d,\s]+\]/);
    if (!match) return candidates;

    const ranking: number[] = JSON.parse(match[0]);
    const reranked: HybridSearchResult[] = [];

    for (const idx of ranking) {
      const i = idx - 1; // Convert to 0-indexed
      if (i >= 0 && i < toRerank.length) {
        const result = toRerank[i];
        result.hybridScore = 1.0 - (reranked.length * 0.05); // Descending score
        reranked.push(result);
      }
    }

    // Add any candidates not in the reranked list
    for (const c of toRerank) {
      if (!reranked.includes(c)) {
        c.hybridScore = 0.1;
        reranked.push(c);
      }
    }

    // Add remaining candidates beyond top 20
    reranked.push(...candidates.slice(20));

    return reranked.slice(0, limit);
  } catch {
    // Reranking failed, return original order
    return candidates;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUERY EXPANSION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Decompose a complex query into sub-queries for multi-hop retrieval.
 * Generates pairs of key words as additional search terms.
 */
function expandQueryTerms(query: string): string[] {
  const stopwords = new Set([
    'what', 'when', 'where', 'who', 'how', 'does', 'did', 'is', 'was',
    'are', 'were', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'has', 'have', 'had', 'do', 'from', 'about', 'been',
    'they', 'this', 'that', 'would', 'could', 'should', 'which', 'will',
    'can', 'but', 'not', 'all', 'her', 'his', 'its', 'our', 'your',
  ]);

  const words = query.toLowerCase().replace(/[?.,!'"]/g, '').split(/\s+/)
    .filter(w => w.length >= 3 && !stopwords.has(w));

  if (words.length <= 3) return [query];

  const subQueries = [query];
  for (let i = 0; i < words.length && subQueries.length < 5; i++) {
    for (let j = i + 1; j < words.length && j < i + 3 && subQueries.length < 5; j++) {
      subQueries.push(`${words[i]} ${words[j]}`);
    }
  }

  return subQueries;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HYBRID SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

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
    type,
    entity,
    entityMatch = 'all',
    after,
    before,
    expandQuery = false,
    factFirst = false,
    rerank = false,
  } = options;

  // Fact-first retrieval: delegate to fact-retrieval engine
  if (factFirst) {
    const { factFirstSearch } = await import('./fact-retrieval.js');
    const factResult = await factFirstSearch(query, root, {
      limit: limit,
      tokenBudget: 4000,
      includeSupporting: true,
    });

    // Convert FactSearchResult to HybridSearchResult[] for backwards compat
    return factResult.facts.map(f => ({
      id: String(f.id),
      title: `[${f.category}] ${f.content.slice(0, 80)}`,
      content: f.content,
      source_path: `fact://${f.id}`,
      timestamp: f.timestamp,
      type: 'note',
      semanticScore: f.score,
      metadataScore: 0,
      hybridScore: f.score,
      matchType: 'semantic' as const,
    }));
  }

  logger.debug('Hybrid search starting', { query, tier, limit, expandQuery, rerank });

  // Generate sub-queries for multi-hop retrieval
  const queries = expandQuery ? expandQueryTerms(query) : [query];

  // ─── Channel 1: Semantic search ──────────────────────────────────────────
  let semanticResults: SearchResult[] = [];
  for (const q of queries) {
    try {
      const results = await semanticSearch(root, q, { limit: limit * 3, type });
      semanticResults.push(...results);
    } catch (err) {
      if (q === query) {
        logger.debug('Semantic search unavailable, using keyword only', { error: String(err) });
      }
    }
  }

  // Deduplicate semantic results by source_path (keep best score)
  const seenPaths = new Map<string, SearchResult>();
  for (const r of semanticResults) {
    const existing = seenPaths.get(r.metadata.source_path);
    if (!existing || r.distance < existing.distance) {
      seenPaths.set(r.metadata.source_path, r);
    }
  }
  semanticResults = Array.from(seenPaths.values());

  // Convert semantic results to ranked list format for RRF
  const semanticRankedList = semanticResults.map(r => ({
    source_path: r.metadata.source_path,
    score: 1 - r.distance,
    data: {
      id: r.id,
      title: r.metadata.title || 'Untitled',
      content: r.content,
      source_path: r.metadata.source_path,
      timestamp: r.metadata.timestamp,
      type: r.metadata.type,
    },
  }));

  // ─── Channel 2: Metadata/keyword search ──────────────────────────────────
  const metadataResults = await metadataSearch(query, root, { limit: limit * 3 });

  // Convert metadata results to ranked list format for RRF
  const metadataRankedList = metadataResults.map(r => ({
    source_path: r.source_path,
    score: r.score,
    data: {
      id: r.id?.toString() || r.source_path,
      title: r.title,
      content: r.summary || '',
      source_path: r.source_path,
      timestamp: r.timestamp,
      type: r.type,
      tier: r.tier,
      priority: r.priority,
      tags: r.tags,
    },
  }));

  // ─── Channel 3: Temporal search ──────────────────────────────────────────
  const temporalResults = await temporalSearch(query, root, limit * 3);

  // ─── Channel 4: Entity graph augmentation (for expanded queries) ─────────
  const entityRankedList: Array<{ source_path: string; score: number; data: any }> = [];

  if (expandQuery) {
    try {
      const timeline = await getTimelineDb(root);
      const { getEntityGraphDb } = await import('./entity-graph.js');
      const entityDb = await getEntityGraphDb(root);

      // Find entities whose names appear in the query
      const queryLower = query.toLowerCase();
      const allEntities = entityDb.prepare(
        'SELECT id, name FROM entities ORDER BY mention_count DESC LIMIT 100'
      ).all() as Array<{ id: number; name: string }>;

      const matchedEntities = allEntities.filter(
        e => queryLower.includes(e.name.toLowerCase()) && e.name.length >= 3
      );

      for (const ent of matchedEntities.slice(0, 3)) {
        const mentions = entityDb.prepare(
          'SELECT DISTINCT source_path FROM entity_mentions WHERE entity_id = ? ORDER BY timestamp DESC LIMIT 10'
        ).all(ent.id) as Array<{ source_path: string }>;

        for (const m of mentions) {
          const event = timeline.prepare(
            'SELECT id, title, summary, source_path, timestamp, type FROM timeline_events WHERE source_path = ?'
          ).get(m.source_path) as any;

          if (event) {
            entityRankedList.push({
              source_path: event.source_path,
              score: 0.8, // Entity graph matches are moderately relevant
              data: {
                id: String(event.id),
                title: event.title || '',
                content: event.summary || '',
                source_path: event.source_path,
                timestamp: event.timestamp,
                type: event.type,
              },
            });
          }
        }
      }
    } catch (err) {
      logger.debug('Entity graph augmentation failed', { error: String(err) });
    }
  }

  // ─── Reciprocal Rank Fusion ──────────────────────────────────────────────
  const rankedLists: Array<Array<{ source_path: string; score: number; data: any }>> = [
    semanticRankedList,
    metadataRankedList,
  ];

  if (temporalResults.length > 0) {
    rankedLists.push(temporalResults);
  }

  if (entityRankedList.length > 0) {
    rankedLists.push(entityRankedList);
  }

  const fused = reciprocalRankFusion(rankedLists);

  // ─── Convert fused results to HybridSearchResult[] ───────────────────────
  // Determine matchType based on which channels contained each source_path
  const semanticPaths = new Set(semanticRankedList.map(r => r.source_path));
  const metadataPaths = new Set(metadataRankedList.map(r => r.source_path));

  const merged = new Map<string, HybridSearchResult>();

  for (const [sourcePath, { rrfScore, data }] of fused) {
    const inSemantic = semanticPaths.has(sourcePath);
    const inMetadata = metadataPaths.has(sourcePath);
    const matchType: 'semantic' | 'keyword' | 'both' =
      inSemantic && inMetadata ? 'both' :
      inSemantic ? 'semantic' : 'keyword';

    merged.set(sourcePath, {
      id: data.id || sourcePath,
      title: data.title || 'Untitled',
      content: data.content || '',
      source_path: sourcePath,
      timestamp: data.timestamp || '',
      type: data.type || 'note',
      tier: data.tier,
      priority: data.priority,
      tags: data.tags,
      semanticScore: inSemantic ? rrfScore : 0,
      metadataScore: inMetadata ? rrfScore : 0,
      hybridScore: rrfScore,
      matchType,
    });
  }

  // ─── Apply MAX_SEGMENTS_PER_PARENT after RRF fusion ──────────────────────
  const MAX_SEGMENTS_PER_PARENT = 3;
  const parentCounts = new Map<string, number>();
  const toRemove: string[] = [];

  // Sort by hybridScore to keep the best segments
  const sortedEntries = Array.from(merged.entries())
    .sort((a, b) => b[1].hybridScore - a[1].hybridScore);

  for (const [sourcePath] of sortedEntries) {
    const parentPath = getParentPath(sourcePath);
    const count = parentCounts.get(parentPath) || 0;
    if (count >= MAX_SEGMENTS_PER_PARENT) {
      toRemove.push(sourcePath);
    } else {
      parentCounts.set(parentPath, count + 1);
    }
  }

  for (const path of toRemove) {
    merged.delete(path);
  }

  // ─── Enrich semantic-only results with tier/priority/tags from timeline ──
  await enrichResults(merged, root);

  // ─── Apply filters and sort ──────────────────────────────────────────────
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
    .sort((a, b) => b.hybridScore - a.hybridScore);

  // ─── Haiku reranking (opt-in) ────────────────────────────────────────────
  if (rerank && results.length > 3) {
    results = await haikusRerank(query, results, limit);
  } else {
    results = results.slice(0, limit);
  }

  // ─── Add related memories from sleep agent edges ─────────────────────────
  if (includeRelated && results.length > 0) {
    results = addRelatedMemories(results, root);
  }

  logger.debug('Hybrid search completed', {
    semanticCount: semanticResults.length,
    metadataCount: metadataResults.length,
    temporalCount: temporalResults.length,
    entityCount: entityRankedList.length,
    fusedCount: fused.size,
    resultCount: results.length,
    reranked: rerank,
  });

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// METADATA SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// ENRICHMENT & RELATED MEMORIES
// ═══════════════════════════════════════════════════════════════════════════════

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
  let sleep: import('../database.js').Database;
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
