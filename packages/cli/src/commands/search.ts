/**
 * Search Command
 *
 * Semantic search across all indexed conversations and documents.
 *
 * Usage:
 *   kyberbot search "query"                    # Basic search
 *   kyberbot search "query" --limit 20         # Limit results
 *   kyberbot search "query" --type conversation # Filter by type
 *   kyberbot search "query" --entity "John"    # Filter by entity
 *   kyberbot search "query" --entity "Nick,Amy"    # Multiple entities (AND)
 *   kyberbot search "query" --entity "Nick,Amy" --entity-match any  # OR logic
 *   kyberbot search "query" --after "last week" # Filter by time
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createLogger } from '../logger.js';
import { semanticSearch, type SearchResult, isChromaAvailable, initializeEmbeddings } from '../brain/embeddings.js';
import { hybridSearch, type HybridSearchResult } from '../brain/hybrid-search.js';
import { getTimelineDb } from '../brain/timeline.js';
import { parseNaturalDate } from '../utils/date-parser.js';
import { getRoot } from '../config.js';

const logger = createLogger('search-cmd');

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface SearchOptions {
  limit: string;
  type?: string;
  entity?: string;
  entityMatch?: 'all' | 'any';
  after?: string;
  before?: string;
  json?: boolean;
  semanticOnly?: boolean;
  tier?: string;
  minPriority?: string;
  group?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESULT GROUPING
// ═══════════════════════════════════════════════════════════════════════════════

interface GroupedResult {
  sourcePath: string;
  title: string;
  type: string;
  timestamp: string;
  bestMatch: SearchResult;
  allChunks: SearchResult[];
  bestScore: number;
  entities?: string[];
}

export function groupResultsByDocument(results: SearchResult[]): GroupedResult[] {
  const grouped = new Map<string, GroupedResult>();

  for (const result of results) {
    const key = result.metadata.source_path;

    if (!grouped.has(key)) {
      grouped.set(key, {
        sourcePath: key,
        title: result.metadata.title || 'Untitled',
        type: result.metadata.type,
        timestamp: result.metadata.timestamp,
        bestMatch: result,
        allChunks: [result],
        bestScore: 1 - result.distance,
        entities: result.metadata.entities,
      });
    } else {
      const existing = grouped.get(key)!;
      existing.allChunks.push(result);

      const score = 1 - result.distance;
      if (score > existing.bestScore) {
        existing.bestMatch = result;
        existing.bestScore = score;
      }

      // Merge entities
      if (result.metadata.entities) {
        const merged = new Set([...(existing.entities || []), ...result.metadata.entities]);
        existing.entities = [...merged];
      }
    }
  }

  return Array.from(grouped.values())
    .sort((a, b) => b.bestScore - a.bestScore);
}

function formatGroupedResult(group: GroupedResult, index: number): void {
  const score = (group.bestScore * 100).toFixed(1);
  const timestamp = new Date(group.timestamp).toLocaleDateString();
  const chunkCount = group.allChunks.length;

  console.log('');
  console.log(chalk.cyan(`${index + 1}. ${group.title}`));

  if (chunkCount > 1) {
    console.log(chalk.dim(`   ${group.type} • ${timestamp} • ${score}% relevance • ${chunkCount} sections`));
  } else {
    console.log(chalk.dim(`   ${group.type} • ${timestamp} • ${score}% relevance`));
  }

  const snippet = group.bestMatch.content.slice(0, 200).replace(/\n/g, ' ');
  console.log(chalk.white(`   "${snippet}${group.bestMatch.content.length > 200 ? '...' : ''}"`));

  if (chunkCount > 1) {
    console.log(chalk.dim(`   [+${chunkCount - 1} more matching sections]`));
  }

  if (group.entities && group.entities.length > 0) {
    console.log(chalk.yellow(`   Entities: ${group.entities.join(', ')}`));
  }

  console.log(chalk.dim(`   Source: ${group.sourcePath}`));
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISPLAY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function formatResult(result: SearchResult, index: number): void {
  const score = ((1 - result.distance) * 100).toFixed(1);
  const timestamp = new Date(result.metadata.timestamp).toLocaleDateString();
  const type = result.metadata.type;

  console.log('');
  console.log(chalk.cyan(`${index + 1}. ${result.metadata.title || 'Untitled'}`));
  console.log(chalk.dim(`   ${type} • ${timestamp} • ${score}% relevance`));

  // Show snippet (truncated)
  const snippet = result.content.slice(0, 200).replace(/\n/g, ' ');
  console.log(chalk.white(`   "${snippet}${result.content.length > 200 ? '...' : ''}"`));

  // Show entities if present
  if (result.metadata.entities && result.metadata.entities.length > 0) {
    console.log(chalk.yellow(`   Entities: ${result.metadata.entities.join(', ')}`));
  }

  // Show source path
  console.log(chalk.dim(`   Source: ${result.metadata.source_path}`));
}

function formatResultsJson(results: SearchResult[]): void {
  const output = results.map((result, index) => ({
    rank: index + 1,
    score: ((1 - result.distance) * 100).toFixed(1),
    title: result.metadata.title || 'Untitled',
    type: result.metadata.type,
    timestamp: result.metadata.timestamp,
    snippet: result.content.slice(0, 200),
    entities: result.metadata.entities || [],
    topics: result.metadata.topics || [],
    source: result.metadata.source_path,
  }));

  console.log(JSON.stringify(output, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILTERING
// ═══════════════════════════════════════════════════════════════════════════════

export function filterByEntity(
  results: SearchResult[],
  entity: string,
  matchMode: 'all' | 'any' = 'all'
): SearchResult[] {
  // Support comma-separated entities: "Nick,Amy"
  const targetEntities = entity.split(',').map(e => e.trim().toLowerCase()).filter(e => e.length > 0);

  if (targetEntities.length === 0) {
    return results;
  }

  return results.filter(result => {
    const docEntities = (result.metadata.entities || []).map(e => e.toLowerCase());

    if (matchMode === 'any') {
      // OR logic: at least one target entity must be mentioned
      return targetEntities.some(target =>
        docEntities.some(e => e.includes(target))
      );
    } else {
      // AND logic (default): ALL target entities must be mentioned
      return targetEntities.every(target =>
        docEntities.some(e => e.includes(target))
      );
    }
  });
}

export function filterByTime(
  results: SearchResult[],
  after?: Date,
  before?: Date
): SearchResult[] {
  return results.filter(result => {
    const timestamp = new Date(result.metadata.timestamp);

    if (after && timestamp < after) {
      return false;
    }
    if (before && timestamp > before) {
      return false;
    }

    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCESS TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

async function trackSearchAccess(root: string, sourcePaths: string[]): Promise<void> {
  if (sourcePaths.length === 0) return;

  try {
    const db = await getTimelineDb(root);
    const stmt = db.prepare(`
      UPDATE timeline_events
      SET access_count = access_count + 1,
          last_accessed = datetime('now')
      WHERE source_path = ?
    `);
    let updated = 0;
    for (const path of sourcePaths) {
      const result = stmt.run(path);
      if (result.changes > 0) updated++;
    }
    logger.debug('Search access tracked', { paths: sourcePaths.length, updated });
  } catch (error) {
    logger.debug('Failed to track search access', { error: String(error) });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleSearch(query: string, options: SearchOptions) {
  try {
    const limit = parseInt(options.limit) || 10;
    const root = getRoot();

    await initializeEmbeddings();

    // Semantic-only fallback (opt-in for debugging or when sleep agent data isn't needed)
    if (options.semanticOnly) {
      if (!isChromaAvailable()) {
        console.log(chalk.red('ChromaDB not available. Start with: docker-compose up -d'));
        process.exit(1);
      }

      const type = options.type as 'conversation' | 'idea' | 'file' | 'transcript' | 'note' | undefined;
      let results = await semanticSearch(query, { limit: limit * 2, type });

      if (options.entity) {
        results = filterByEntity(results, options.entity, options.entityMatch || 'all');
      }

      const afterDate = options.after ? parseNaturalDate(options.after) : undefined;
      const beforeDate = options.before ? parseNaturalDate(options.before) : undefined;
      if (afterDate || beforeDate) {
        results = filterByTime(results, afterDate, beforeDate);
      }

      results = results.slice(0, limit);

      if (results.length === 0) {
        console.log(chalk.yellow('No results found.'));
        return;
      }

      if (options.json) {
        formatResultsJson(results);
      } else {
        const grouped = groupResultsByDocument(results);
        console.log(chalk.cyan.bold(`Found ${grouped.length} documents (${results.length} chunks)`));
        console.log(chalk.dim('-'.repeat(60)));
        for (let i = 0; i < grouped.slice(0, limit).length; i++) {
          formatGroupedResult(grouped[i], i);
        }
        console.log('');
      }

      await trackSearchAccess(root, results.map(r => r.metadata.source_path));
      return;
    }

    // Default: Hybrid search (semantic + keyword + priority + tiers + edges)
    console.log(chalk.dim(`Searching: "${query}"`));

    const hybridResults = await hybridSearch(query, root, {
      limit,
      tier: (options.tier as 'hot' | 'warm' | 'archive' | 'all') || 'all',
      minPriority: options.minPriority ? parseFloat(options.minPriority) : 0,
      type: options.type as 'conversation' | 'idea' | 'file' | 'transcript' | 'note' | undefined,
      entity: options.entity,
      entityMatch: options.entityMatch || 'all',
      after: options.after ? parseNaturalDate(options.after) : undefined,
      before: options.before ? parseNaturalDate(options.before) : undefined,
      includeRelated: true,
    });

    if (hybridResults.length === 0) {
      console.log(chalk.yellow('No results found.'));
      if (options.entity || options.after || options.before || options.tier) {
        console.log(chalk.dim('Try removing filters for broader results.'));
      }
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(hybridResults, null, 2));
    } else {
      console.log(chalk.cyan.bold(`Found ${hybridResults.length} results`));
      console.log(chalk.dim('-'.repeat(60)));

      for (let i = 0; i < hybridResults.length; i++) {
        const r = hybridResults[i];
        const score = (r.hybridScore * 100).toFixed(1);
        const timestamp = new Date(r.timestamp).toLocaleDateString();

        const matchLabel = r.matchType === 'both' ? chalk.green('S+K')
          : r.matchType === 'semantic' ? chalk.blue('SEM')
          : chalk.yellow('KEY');

        const tierLabel = r.tier === 'hot' ? chalk.red(r.tier)
          : r.tier === 'warm' ? chalk.yellow(r.tier)
          : r.tier === 'archive' ? chalk.dim(r.tier) : '';

        console.log('');
        console.log(chalk.cyan(`${i + 1}. ${r.title}`));
        console.log(chalk.dim(`   ${r.type} | ${timestamp} | ${score}% | ${matchLabel}${tierLabel ? ' | ' + tierLabel : ''}`));

        const snippet = r.content.slice(0, 200).replace(/\n/g, ' ');
        if (snippet) {
          console.log(chalk.white(`   "${snippet}${r.content.length > 200 ? '...' : ''}"`));
        }

        if (r.tags && r.tags.length > 0) {
          console.log(chalk.dim(`   Tags: ${r.tags.slice(0, 6).join(', ')}`));
        }

        if (r.relatedMemories && r.relatedMemories.length > 0) {
          const related = r.relatedMemories.map(p => p.split('/').pop()?.replace(/\.[^.]+$/, '')).join(', ');
          console.log(chalk.magenta(`   -> Related: ${related}`));
        }
      }

      console.log('');
      console.log(chalk.dim('-'.repeat(60)));
      console.log(chalk.dim(`${hybridResults.length} results shown`));
      console.log('');
    }

    // Track access for returned results
    await trackSearchAccess(root, hybridResults.map(r => r.source_path));
  } catch (error) {
    logger.error('Search failed', { error: String(error) });
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

export function createSearchCommand(): Command {
  return new Command('search')
    .description('Semantic search across all indexed content')
    .argument('<query>', 'Natural language search query')
    .option('-l, --limit <n>', 'Maximum number of results', '10')
    .option('-t, --type <type>', 'Filter by type (conversation, idea, file, transcript, note)')
    .option('-e, --entity <name>', 'Filter by entity (comma-separated for multiple: "Nick,Amy")')
    .option('--entity-match <mode>', 'Entity match mode: all (default, AND logic) or any (OR logic)', 'all')
    .option('-a, --after <date>', 'Only results after this date (e.g., "last week", "2026-01-01")')
    .option('-b, --before <date>', 'Only results before this date')
    .option('--json', 'Output results as JSON', false)
    .option('-g, --group', 'Group results by document (semantic-only mode)', true)
    .option('--no-group', 'Show individual chunks without grouping')
    .option('--semantic-only', 'Use pure semantic search without sleep agent intelligence', false)
    .option('--tier <tier>', 'Filter by tier: hot, warm, archive, all', 'all')
    .option('--min-priority <n>', 'Minimum priority score 0-1', '0')
    .action(handleSearch);
}
