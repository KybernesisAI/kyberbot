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
import { addConversationToTimeline } from './timeline.js';
import {
  findOrCreateEntity,
  addEntityMention,
  linkEntitiesWithType,
  linkEntities,
} from './entity-graph.js';
import { extractRelationships } from './relationship-extractor.js';
import { indexDocument, isChromaAvailable } from './embeddings.js';

const logger = createLogger('brain');

export interface ConversationInput {
  prompt: string;
  response: string;
  channel: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Store a conversation across all memory subsystems.
 * Call fire-and-forget — never throws, logs all errors internally.
 */
export async function storeConversation(
  root: string,
  input: ConversationInput
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

  const entityNames = entities.map((e) => e.name);
  const topicNames = entities
    .filter((e) => e.type === 'topic')
    .map((e) => e.name);

  // ── Step 2: Timeline ─────────────────────────────────────────────────
  try {
    const title = input.prompt.length > 100
      ? input.prompt.slice(0, 97) + '...'
      : input.prompt;

    await addConversationToTimeline(
      root,
      conversationId,
      sourcePath,
      timestamp,
      undefined,
      `[${input.channel}] ${title}`,
      input.response.length > 500
        ? input.response.slice(0, 497) + '...'
        : input.response,
      entityNames,
      topicNames
    );
    logger.debug('Stored conversation in timeline', { conversationId });
  } catch (err) {
    logger.warn('Timeline storage failed', { error: String(err) });
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

    // Link entities with typed relationships from extraction
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

    // Co-occur all entities that appeared together
    const entityIds = [...entityMap.values()];
    for (let i = 0; i < entityIds.length; i++) {
      for (let j = i + 1; j < entityIds.length; j++) {
        try {
          await linkEntities(root, entityIds[i], entityIds[j]);
        } catch (err) {
          // Silently skip co-occurrence failures
        }
      }
    }

    logger.debug('Stored entities in graph', {
      entities: entityMap.size,
      relationships: relationships.length,
    });
  } catch (err) {
    logger.warn('Entity graph storage failed', { error: String(err) });
  }

  // ── Step 4: Embeddings (best-effort) ─────────────────────────────────
  try {
    if (isChromaAvailable()) {
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
