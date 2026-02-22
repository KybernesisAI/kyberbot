/**
 * Recall Command
 *
 * Natural language entity queries for Claude Code integration.
 * Outputs clean, readable information that Claude can synthesize.
 *
 * Usage:
 *   kyberbot recall "John Smith"
 *   kyberbot recall "What do I know about Acme Corp?"
 *   kyberbot recall "My Projects"
 */

import { Command } from 'commander';
import {
  getEntityContext,
  searchEntities,
  getEntityGraphStats,
  getMostMentionedEntities,
  getEntityGraphDb,
  getTypedRelationships,
} from '../brain/entity-graph.js';
import { formatRelationship } from '../brain/relationship-extractor.js';
import {
  queryTimeline,
  getRecentActivity,
  getTimelineDb,
} from '../brain/timeline.js';
import { getSleepDb } from '../brain/sleep/db.js';
import { getRoot } from '../config.js';

// ═══════════════════════════════════════════════════════════════════════════════
// QUERY PARSING
// ═══════════════════════════════════════════════════════════════════════════════

function extractEntityName(query: string): string {
  // Remove common question patterns
  return query
    .replace(/^(who is|what is|what do (i|you) know about|tell me about|recall)\s+/i, '')
    .replace(/\?+$/, '')
    .trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// OUTPUT FORMATTERS (clean, no chalk, readable by Claude)
// ═══════════════════════════════════════════════════════════════════════════════

async function formatEntityContext(
  context: NonNullable<Awaited<ReturnType<typeof getEntityContext>>>,
  root: string
): Promise<string> {
  const { entity, mentions, related_entities } = context;
  const lines: string[] = [];

  // Header
  lines.push(`# ${entity.name}`);
  lines.push('');
  lines.push(`Type: ${entity.type}`);
  lines.push(`First mentioned: ${new Date(entity.first_seen).toLocaleDateString()}`);
  lines.push(`Last mentioned: ${new Date(entity.last_seen).toLocaleDateString()}`);
  lines.push(`Total mentions: ${entity.mention_count}`);

  if (entity.aliases.length > 0) {
    lines.push(`Also known as: ${entity.aliases.join(', ')}`);
  }

  // Typed relationships (e.g., "founded", "works_at")
  try {
    const typedRels = await getTypedRelationships(root, entity.id);
    if (typedRels.length > 0) {
      lines.push('');
      lines.push('## Relationships');
      for (const rel of typedRels) {
        const verb = formatRelationship(rel.entity.name, rel.relationship, rel.direction);
        const confidence = rel.confidence >= 0.8 ? '' : ` (${Math.round(rel.confidence * 100)}% confident)`;
        lines.push(`- ${entity.name} ${verb} ${rel.entity.name}${confidence}`);
        if (rel.rationale) {
          lines.push(`  -- ${rel.rationale}`);
        }
      }
    }
  } catch {
    // Non-critical, continue without typed relationships
  }

  // Mentions with context
  if (mentions.length > 0) {
    lines.push('');
    lines.push('## Mentions');
    for (const mention of mentions.slice(0, 10)) {
      const date = new Date(mention.timestamp).toLocaleDateString();
      if (mention.context) {
        lines.push(`- [${date}] ${mention.context}`);
      } else {
        lines.push(`- [${date}] Mentioned in conversation`);
      }
    }
    if (mentions.length > 10) {
      lines.push(`- ... and ${mentions.length - 10} more mentions`);
    }
  }

  // Co-occurred entities (simpler relationships)
  if (related_entities.length > 0) {
    lines.push('');
    lines.push('## Co-occurred With');
    for (const rel of related_entities.slice(0, 10)) {
      lines.push(`- ${rel.entity.name} (${rel.entity.type}) - appeared together ${rel.strength} time(s)`);
    }
  }

  return lines.join('\n');
}

function formatSearchResults(results: Awaited<ReturnType<typeof searchEntities>>): string {
  if (results.length === 0) {
    return 'No matching entities found.';
  }

  const lines: string[] = ['# Search Results', ''];

  for (const entity of results) {
    lines.push(`- ${entity.name} (${entity.type}) - ${entity.mention_count} mention(s)`);
  }

  return lines.join('\n');
}

function formatStats(stats: Awaited<ReturnType<typeof getEntityGraphStats>>): string {
  const lines: string[] = [
    '# Entity Graph Summary',
    '',
    `Total entities tracked: ${stats.total_entities}`,
    `Total mentions recorded: ${stats.total_mentions}`,
    `Entity relationships: ${stats.total_relations}`,
    '',
    '## By Type',
    `- People: ${stats.by_type.person}`,
    `- Companies: ${stats.by_type.company}`,
    `- Projects: ${stats.by_type.project}`,
    `- Places: ${stats.by_type.place}`,
    `- Topics: ${stats.by_type.topic}`,
  ];

  return lines.join('\n');
}

function formatTopEntities(entities: Awaited<ReturnType<typeof getMostMentionedEntities>>): string {
  if (entities.length === 0) {
    return 'No entities recorded yet.';
  }

  const lines: string[] = ['# Most Mentioned Entities', ''];

  for (const entity of entities) {
    lines.push(`- ${entity.name} (${entity.type}) - ${entity.mention_count} mention(s)`);
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY GRAPH INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════

async function getRelatedMemories(root: string, entityName: string): Promise<string[]> {
  try {
    const timeline = await getTimelineDb(root);
    const sleep = getSleepDb(root);

    // Find source_paths where this entity appears (via tags or title)
    const entityLower = entityName.toLowerCase();
    const sourcePaths = timeline.prepare(`
      SELECT DISTINCT source_path FROM timeline_events
      WHERE LOWER(title) LIKE ? OR LOWER(tags_json) LIKE ? OR LOWER(entities_json) LIKE ?
      LIMIT 20
    `).all(`%${entityLower}%`, `%${entityLower}%`, `%${entityLower}%`) as Array<{ source_path: string }>;

    if (sourcePaths.length === 0) return [];

    // Find connected memories via sleep agent edges
    const relatedPaths = new Set<string>();
    for (const { source_path } of sourcePaths) {
      const edges = sleep.prepare(`
        SELECT
          CASE WHEN from_path = ? THEN to_path ELSE from_path END as related_path,
          confidence, shared_tags
        FROM memory_edges
        WHERE from_path = ? OR to_path = ?
        ORDER BY confidence DESC
        LIMIT 3
      `).all(source_path, source_path, source_path) as Array<{ related_path: string; confidence: number; shared_tags: string }>;

      for (const edge of edges) {
        if (!sourcePaths.some(s => s.source_path === edge.related_path)) {
          relatedPaths.add(edge.related_path);
        }
      }
    }

    if (relatedPaths.size === 0) return [];

    // Get titles for related paths
    const lines: string[] = [];
    for (const path of relatedPaths) {
      const item = timeline.prepare(`
        SELECT title, tier, timestamp FROM timeline_events WHERE source_path = ?
      `).get(path) as { title: string; tier: string; timestamp: string } | undefined;

      if (item) {
        const date = new Date(item.timestamp).toLocaleDateString();
        lines.push(`- ${item.title} [${date}] (${item.tier})`);
      }
    }

    return lines;
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleRecall(query: string | undefined) {
  try {
    const root = getRoot();

    // No query = show summary
    if (!query) {
      const stats = await getEntityGraphStats(root);
      console.log(formatStats(stats));
      console.log('');

      const top = await getMostMentionedEntities(root, { limit: 10 });
      console.log(formatTopEntities(top));
      return;
    }

    // Extract entity name from natural language
    const entityName = extractEntityName(query);

    // Try exact match first
    const context = await getEntityContext(root, entityName);

    if (context) {
      console.log(await formatEntityContext(context, root));

      // Show connected memories from sleep agent graph
      const relatedMemories = await getRelatedMemories(root, entityName);
      if (relatedMemories.length > 0) {
        console.log('');
        console.log('## Connected Memories');
        for (const line of relatedMemories) {
          console.log(line);
        }
      }

      await trackEntityAccess(root, context.entity.id);
      return;
    }

    // Try search
    const results = await searchEntities(root, entityName, { limit: 10 });

    if (results.length === 1) {
      // Single match - show full context
      const singleContext = await getEntityContext(root, results[0].id);
      if (singleContext) {
        console.log(await formatEntityContext(singleContext, root));

        const relatedMemories = await getRelatedMemories(root, results[0].name);
        if (relatedMemories.length > 0) {
          console.log('');
          console.log('## Connected Memories');
          for (const line of relatedMemories) {
            console.log(line);
          }
        }

        await trackEntityAccess(root, singleContext.entity.id);
        return;
      }
    }

    if (results.length > 0) {
      console.log(formatSearchResults(results));
      return;
    }

    // Nothing found
    console.log(`No information found about "${entityName}".`);
    console.log('');
    console.log('This entity has not been mentioned in any processed conversations yet.');

  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCESS TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

async function trackEntityAccess(root: string, entityId: number): Promise<void> {
  try {
    const db = await getEntityGraphDb(root);
    db.prepare(`
      UPDATE entities
      SET access_count = access_count + 1,
          last_accessed = datetime('now')
      WHERE id = ?
    `).run(entityId);
  } catch {
    // Non-critical, ignore failures
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

export function createRecallCommand(): Command {
  return new Command('recall')
    .description('Query what you know about a person, project, or topic')
    .argument('[query]', 'Entity name or natural language question')
    .action(handleRecall);
}
