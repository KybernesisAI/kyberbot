/**
 * KyberBot — Conversation Memory Storage
 *
 * Orchestrator that stores conversation data across all memory subsystems:
 * - Timeline (always) — temporal event index
 * - Entity Graph (always) — entities, mentions, and typed relationships
 * - Embeddings (best-effort) — semantic search via ChromaDB
 *
 * Designed to be called fire-and-forget after a reply is sent.
 * Each subsystem is individually wrapped — one failure doesn't block others.
 */

import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';
import { addConversationToTimeline, findRecentDuplicate, incrementTimelineEventCount } from './timeline.js';
import {
  findOrCreateEntity,
  addEntityMention,
  linkEntitiesWithType,
} from './entity-graph.js';
import { extractRelationships } from './relationship-extractor.js';
import { indexDocument, isChromaAvailable } from './embeddings.js';

const logger = createLogger('brain');

// ═══════════════════════════════════════════════════════════════════════════════
// SEGMENT SPLITTING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Split text into overlapping segments for fine-grained indexing.
 * Each segment is a self-contained chunk that can be independently searched.
 */
function segmentText(text: string, segmentSize: number = 250, overlap: number = 50): Array<{ text: string; index: number }> {
  if (text.length <= segmentSize) {
    return [{ text, index: 0 }];
  }

  const segments: Array<{ text: string; index: number }> = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    let end = start + segmentSize;

    // Try to break at a sentence or line boundary
    if (end < text.length) {
      const slice = text.slice(start, end + 50); // look ahead a bit
      const breakPoint = slice.lastIndexOf('\n');
      const sentenceBreak = slice.search(/[.!?]\s+[A-Z]/);
      if (breakPoint > segmentSize * 0.6) {
        end = start + breakPoint + 1;
      } else if (sentenceBreak > segmentSize * 0.6) {
        end = start + sentenceBreak + 2;
      }
    } else {
      end = text.length;
    }

    segments.push({ text: text.slice(start, end).trim(), index });
    index++;
    start = end - overlap;
    if (start >= text.length) break;
  }

  return segments;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOISE ENTITY FILTERING
// ═══════════════════════════════════════════════════════════════════════════════

const NOISE_ENTITY_PATTERNS: RegExp[] = [
  /^(curl|wget|bash|sh|zsh|npm|pnpm|yarn|pip|git|docker|node|python|make|gcc)$/i,
  /^(BLOCKED|ERROR|FAIL|OK|SUCCESS|null|undefined|true|false|none|N\/A)$/i,
  /^(max\s+turns?\s+limit|rate\s+limit|timeout|sandbox|retry|fallback|skip)$/i,
  /^(settings|config|permissions?|terminal|shell|command|script)$/i,
  /^(stdout|stderr|stdin|exit code|error|warning)$/i,
  /\.(json|yaml|yml|md|ts|js|py|sh|env|toml|lock|log|txt|csv|db)$/i,
  /^[.\/~].*\//,       // file paths
  /^\d+$/,              // bare numbers
  /^.{1,2}$/,           // single/double char
  /^(the|this|that|it|they|we|i|you|he|she|my|our)$/i,  // pronouns
  /^[a-f0-9-]{36}$/i,  // UUIDs
  /^(http|https|localhost|127\.0\.0\.1|0\.0\.0\.0)/i,    // URLs/hosts
];

/**
 * Filter noise entities from extraction results.
 * Uses built-in patterns plus optional agent-specific stoplist.
 */
export function filterNoiseEntities(
  entities: Array<{ name: string; type: string }>,
  agentStoplist: string[] = []
): Array<{ name: string; type: string }> {
  const stopSet = new Set(agentStoplist.map((s) => s.toLowerCase()));

  return entities.filter((e) => {
    const name = e.name.trim();
    const lower = name.toLowerCase();

    if (stopSet.has(lower)) return false;
    if (NOISE_ENTITY_PATTERNS.some((p) => p.test(name))) return false;

    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ConversationInput {
  prompt: string;
  response: string;
  channel: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Store a conversation across all memory subsystems.
 * Call fire-and-forget — never throws, logs all errors internally.
 */
export async function storeConversation(
  root: string,
  input: ConversationInput,
  options: { entityStoplist?: string[] } = {}
): Promise<void> {
  const conversationId = randomUUID();
  const timestamp = input.timestamp || new Date().toISOString();
  const sourcePath = `channel://${input.channel}/${conversationId}`;
  const fullText = `User: ${input.prompt}\n\nAssistant: ${input.response}`;

  logger.debug('Storing conversation', {
    channel: input.channel,
    conversationId,
    promptLength: input.prompt.length,
    responseLength: input.response.length,
  });

  // ── Step 1: Extract entities and relationships via Haiku ──────────────
  let entities: Array<{ name: string; type: string }> = [];
  let relationships: Array<{
    source: { name: string; type: string };
    target: { name: string; type: string };
    relationship: string;
    confidence: number;
    rationale: string;
  }> = [];

  try {
    const extraction = await extractRelationships(fullText);
    entities = extraction.entities;
    relationships = extraction.relationships;
    logger.debug('Extracted from conversation', {
      entities: entities.length,
      relationships: relationships.length,
    });
  } catch (err) {
    logger.warn('Entity extraction failed', { error: String(err) });
  }

  // ── Step 1b: Filter noise entities ────────────────────────────────────
  const preFilterCount = entities.length;
  entities = filterNoiseEntities(entities, options.entityStoplist);
  if (entities.length < preFilterCount) {
    logger.debug('Filtered noise entities', {
      before: preFilterCount,
      after: entities.length,
      removed: preFilterCount - entities.length,
    });
  }

  // Also filter relationships referencing removed entities
  const entityNameSet = new Set(entities.map((e) => e.name.toLowerCase()));
  relationships = relationships.filter(
    (r) =>
      entityNameSet.has(r.source.name.toLowerCase()) &&
      entityNameSet.has(r.target.name.toLowerCase())
  );

  const entityNames = entities.map((e) => e.name);
  const topicNames = entities
    .filter((e) => e.type === 'topic')
    .map((e) => e.name);

  // ── Step 2: Timeline ─────────────────────────────────────────────────
  const title = input.prompt.length > 100
    ? input.prompt.slice(0, 97) + '...'
    : input.prompt;

  // Extract date context from the prompt (e.g., "DATE: 8 May, 2023")
  const dateMatch = input.prompt.match(/^DATE:\s*(.+?)$/m);
  const sessionDate = dateMatch ? dateMatch[1].trim() : '';

  const fullTitle = sessionDate
    ? `[${input.channel}] ${sessionDate} — ${title}`
    : `[${input.channel}] ${title}`;

  try {

    // Deduplicate heartbeat/repetitive content
    if (input.channel === 'heartbeat') {
      const existing = await findRecentDuplicate(root, fullTitle, 24);
      if (existing) {
        await incrementTimelineEventCount(root, existing.id);
        logger.debug('Deduplicated heartbeat timeline entry', { title: fullTitle });
        // Skip creating new timeline entry but continue to entity graph + embeddings
      } else {
        await addConversationToTimeline(
          root, conversationId, sourcePath, timestamp, undefined,
          fullTitle,
          fullText.slice(0, 2000), // Parent entry gets first 2000 chars; segments have full text
          entityNames, topicNames
        );
      }
    } else {
      await addConversationToTimeline(
        root, conversationId, sourcePath, timestamp, undefined,
        fullTitle,
        fullText.slice(0, 2000), // Parent entry gets first 2000 chars; segments have full text
        entityNames, topicNames
      );
    }

    logger.debug('Stored conversation in timeline', { conversationId });
  } catch (err) {
    logger.warn('Timeline storage failed', { error: String(err) });
  }

  // ── Step 2b: Segment-level indexing for fine-grained retrieval ────
  try {
    const segments = segmentText(fullText, 250, 50);
    if (segments.length > 1) { // Only segment if text is long enough to split
      for (const seg of segments) {
        const segPath = `${sourcePath}/seg_${seg.index}`;
        const segId = `${conversationId}_seg_${seg.index}`;

        // Store segment in timeline (for FTS)
        try {
          await addConversationToTimeline(
            root, segId, segPath, timestamp, undefined,
            fullTitle, seg.text, entityNames, topicNames
          );
        } catch {
          // Segment storage is best-effort
        }

        // Store segment in ChromaDB (for semantic search)
        try {
          if (isChromaAvailable()) {
            await indexDocument(segId, seg.text, {
              type: 'conversation',
              source_path: segPath,
              title: fullTitle,
              timestamp,
              entities: entityNames,
              topics: topicNames,
              summary: seg.text, // full segment text, not truncated
            });
          }
        } catch {
          // Segment embedding is best-effort
        }
      }
      logger.debug('Stored conversation segments', {
        conversationId,
        segments: segments.length,
      });
    }
  } catch (err) {
    logger.warn('Segment storage failed', { error: String(err) });
  }

  // ── Step 3: Entity Graph ─────────────────────────────────────────────
  try {
    // Create entities and add mentions
    const entityMap = new Map<string, number>();

    for (const entity of entities) {
      try {
        const dbEntity = await findOrCreateEntity(
          root,
          entity.name,
          entity.type as any,
          timestamp
        );
        entityMap.set(entity.name, dbEntity.id);

        await addEntityMention(
          root,
          dbEntity.id,
          conversationId,
          sourcePath,
          input.prompt.slice(0, 200),
          timestamp
        );
      } catch (err) {
        logger.warn(`Failed to store entity: ${entity.name}`, { error: String(err) });
      }
    }

    // Link entities with typed relationships from extraction only
    for (const rel of relationships) {
      try {
        const sourceId = entityMap.get(rel.source.name);
        const targetId = entityMap.get(rel.target.name);
        if (sourceId && targetId && sourceId !== targetId) {
          await linkEntitiesWithType(root, sourceId, targetId, {
            relationship: rel.relationship as any,
            confidence: rel.confidence,
            rationale: rel.rationale,
          });
        }
      } catch (err) {
        logger.warn('Failed to link entities', { error: String(err) });
      }
    }

    // NOTE: Co-occurrence links removed — they polluted the graph with O(n²)
    // meaningless relationships. The sleep agent's link step now discovers
    // meaningful edges via tag/entity overlap analysis.

    logger.debug('Stored entities in graph', {
      entities: entityMap.size,
      relationships: relationships.length,
    });
  } catch (err) {
    logger.warn('Entity graph storage failed', { error: String(err) });
  }

  // ── Step 4: Embeddings (best-effort) ─────────────────────────────────
  // Skip parent-level ChromaDB indexing if segments were created (Step 2b).
  // Segments provide finer-grained embeddings; indexing the full text too
  // would double-index and waste memory/API calls.
  const hasSegments = fullText.length > 250;
  try {
    if (isChromaAvailable() && !hasSegments) {
      await indexDocument(conversationId, fullText, {
        type: 'conversation',
        source_path: sourcePath,
        title: `[${input.channel}] ${input.prompt.slice(0, 80)}`,
        timestamp,
        entities: entityNames,
        topics: topicNames,
        summary: input.response.slice(0, 300),
      });
      logger.debug('Indexed conversation in embeddings', { conversationId });
    }
  } catch (err) {
    logger.warn('Embedding indexing failed', { error: String(err) });
  }

  logger.info('Conversation stored', {
    conversationId,
    channel: input.channel,
    entities: entityNames.length,
    relationships: relationships.length,
  });
}
