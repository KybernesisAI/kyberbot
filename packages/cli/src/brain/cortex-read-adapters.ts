/**
 * Adapter functions for the `KYBERBOT_USE_CORTEX_READS=1` flag-gated swap.
 *
 * Each function calls the relevant `@kybernesis/cortex-*` API and reshapes
 * its result to match KyberBot's local-store return contract, so callers
 * are oblivious to where the data came from. All adapters return `null`
 * (or an equivalent empty result) when the Cortex singleton is
 * uninitialised — the caller then falls through to its local implementation
 * rather than throwing.
 *
 * Lives in a single file deliberately: makes the swap surface auditable in
 * one read, and keeps the legacy local-store code in its original files
 * unchanged. When KyberBot's local stores are eventually decommissioned,
 * delete this file and inline the Cortex calls directly.
 */

import type { FactCategory } from '@kybernesis/cortex-contracts';
import { getCortexInstance } from './cortex-singleton.js';
import { getEntityGraphDb } from './entity-graph.js';
import type { Entity, EntityType, RelationshipType } from './entity-graph.js';
import { createLogger } from '../logger.js';

import type { FactSearchResult } from './fact-retrieval.js';
import type { StoredFact } from './fact-store.js';
import type { HybridSearchResult } from './hybrid-search.js';

const logger = createLogger('cortex-read-adapters');

// ═══════════════════════════════════════════════════════════════════════════════
// fact-retrieval
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Adapter for `factFirstSearch`. Cortex `factRetrieval` returns a
 * `FactRetrievalResult` bundle; we reshape to KyberBot's `FactSearchResult`.
 *
 * Notable shape differences absorbed here:
 * - Cortex `facts[].fact.id` is a string UUID; KyberBot's `facts[].id` is
 *   a local autoincrement number. We map the UUID to a synthetic positive
 *   integer (FNV-style hash) so callers expecting `number` still work.
 *   Stable for a given UUID but not back-resolvable to KyberBot's row.
 *   Downstream code that uses `id` as a DB key (e.g. `trackFactAccess`)
 *   silently no-ops when reading from Cortex — appropriate because the
 *   row that was actually read lives on the Cortex side.
 * - Cortex `supportingMemories` carry `Memory` objects; KyberBot's
 *   `supporting_context` is shaped around timeline segments. We map
 *   Memory.content + sourcePath + timestamp into the segment shape.
 *   `related_fact_id` is best-effort: when Memory has no `sourceMemoryId`
 *   backlink we synthesise from the first Cortex fact's id.
 */
export async function factFirstSearchViaCortex(
  query: string,
  opts: { limit: number; tokenBudget: number },
): Promise<FactSearchResult | null> {
  const cortex = getCortexInstance();
  if (!cortex) return null;

  try {
    const qr = await cortex.retrieve.factRetrieval({
      query,
      tokenBudget: opts.tokenBudget,
    });

    const facts = qr.data.facts.slice(0, opts.limit).map((sf) => ({
      id: hashUuidToInt(sf.fact.id),
      content: sf.fact.fact,
      category: (sf.fact.category ?? 'general') as string,
      confidence: sf.fact.confidence,
      timestamp: sf.fact.createdAt ?? new Date().toISOString(),
      entities: sf.fact.entities ?? [],
      score: sf.score,
      source: mapCortexFactSourceToKb(sf.source),
    }));

    const supporting_context = qr.data.supportingMemories.map((sm) => ({
      content: sm.memory.content,
      source_path: `cortex://${sm.memory.id}`,
      timestamp: sm.memory.createdAt,
      related_fact_id: facts[0]?.id ?? 0,
    }));

    return {
      facts,
      supporting_context,
      assembled_context: qr.data.assembledContext,
      token_estimate: qr.data.tokenEstimate,
      stats: {
        direct_facts: qr.data.stats.perLayerCounts.fact_direct_facts ?? 0,
        expanded_facts: qr.data.stats.perLayerCounts.entity_expansion ?? 0,
        graph_expanded_facts: qr.data.stats.perLayerCounts.graph_expansion ?? 0,
        scene_expanded_facts: 0,
        bridge_facts: qr.data.stats.perLayerCounts.bridge ?? 0,
        supporting_chunks: supporting_context.length,
        pruned_items: 0,
      },
    };
  } catch (err) {
    logger.warn('Cortex factRetrieval failed; caller will fall back to local', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Adapter for `hybridSearch`. Cortex's `hybridSearch` returns
 * `HybridSearchResult[]` with a Memory + score-channel breakdown; we reshape
 * to KyberBot's `HybridSearchResult` (which is timeline-event-shaped).
 * Memory.id is passed through as the result id. `matchType` is mapped from
 * Cortex's `'semantic' | 'keyword' | 'both'` directly. `metadataScore` /
 * `hybridScore` are derived from Cortex's `keywordScore` + `score`.
 */
export async function hybridSearchViaCortex(
  query: string,
  opts: { limit: number; tier?: 'hot' | 'warm' | 'archive' | 'all' },
): Promise<HybridSearchResult[] | null> {
  const cortex = getCortexInstance();
  if (!cortex) return null;

  try {
    const tier = opts.tier && opts.tier !== 'all' ? opts.tier : undefined;
    const qr = await cortex.retrieve.hybridSearch({
      query,
      topK: opts.limit,
      ...(tier ? { tier } : {}),
    });

    return qr.data.map((row) => ({
      id: row.memory.id,
      title: row.memory.title,
      content: row.memory.content,
      source_path: `cortex://${row.memory.id}`,
      timestamp: row.memory.createdAt,
      type: 'note',
      tier: row.memory.tier,
      priority: row.memory.priority,
      tags: row.memory.tags,
      semanticScore: row.semanticScore,
      metadataScore: row.keywordScore,
      hybridScore: row.score,
      matchType: row.matchType,
    }));
  } catch (err) {
    logger.warn('Cortex hybridSearch failed; caller will fall back to local', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// fact-store
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Adapter for `getFactsForEntity`. Returns Cortex facts shaped as
 * KyberBot `StoredFact[]`. `id`/`superseded_by` use the same UUID-hash
 * trick as `factFirstSearchViaCortex`. `is_latest` from Cortex's
 * `isLatest` boolean maps to KB's `0|1`.
 */
export async function getFactsForEntityViaCortex(
  entityName: string,
  opts: { latestOnly?: boolean; limit?: number; category?: FactCategory } = {},
): Promise<StoredFact[] | null> {
  const cortex = getCortexInstance();
  if (!cortex) return null;

  try {
    const facts = await cortex.providers.structured.getFactsForEntity(
      entityName,
      undefined,            // attribute filter — not used by KB callers
      undefined,            // asOf
      opts.latestOnly ?? true,
    );

    const limit = opts.limit ?? facts.length;
    const filtered = opts.category
      ? facts.filter((f) => f.category === opts.category)
      : facts;

    return filtered.slice(0, limit).map((f) => ({
      id: hashUuidToInt(f.id),
      content: f.fact,
      source_path: f.sourcePath ?? '',
      source_conversation_id: f.sourceConversationId ?? '',
      entities: f.entities ?? [],
      timestamp: f.createdAt,
      confidence: f.confidence,
      category: (f.category ?? 'general') as FactCategory,
      created_at: f.createdAt,
      is_latest: f.isLatest === false ? 0 : 1,
      superseded_by: f.supersededBy ? hashUuidToInt(f.supersededBy) : null,
      ...(f.expiresAt ? { expires_at: f.expiresAt } : {}),
    }));
  } catch (err) {
    logger.warn('Cortex getFactsForEntity failed; caller will fall back', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Adapter for `getFactById`. KB id is a number; we cannot reverse-resolve
 * a hashed UUID back to a Cortex id, so this adapter is callable only when
 * the caller already has the Cortex UUID (via a prior Cortex result). For
 * the common path (KB passes a local number id), no Cortex lookup is
 * possible — returns null and lets the local store handle it. */
export async function getFactByIdViaCortex(_id: number): Promise<StoredFact | null> {
  // KB's number id cannot round-trip to Cortex's UUID. Caller falls through.
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// entity-graph
// ═══════════════════════════════════════════════════════════════════════════════

/** Adapter for `getEntityProfile`. Maps Cortex `EntityProfile` to KB shape.
 * KB's entityId is a number (entity-graph.db autoincrement); Cortex's is
 * a string UUID. Caller must already hold the Cortex id (e.g. from a
 * Cortex-sourced entity list) for this to fire — same constraint as
 * `getFactByIdViaCortex`. Returns null on KB-local id lookups. */
export async function getEntityProfileViaCortex(
  _entityIdOrName: number | string,
): Promise<{ paragraph: string; updated_at: string; fact_count: number } | null> {
  const cortex = getCortexInstance();
  if (!cortex) return null;
  if (typeof _entityIdOrName === 'number') return null;
  try {
    const qr = await cortex.retrieve.getEntityProfile(_entityIdOrName);
    if (!qr.data) return null;
    return {
      paragraph: qr.data.narrativeProse ?? qr.data.dynamicContext,
      updated_at: new Date().toISOString(),
      fact_count: qr.data.staticFacts.length,
    };
  } catch (err) {
    logger.warn('Cortex getEntityProfile failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Adapter for `getTypedRelationships`. Uses Cortex's `getEdgesFor` (v2.1.4+)
 * to fetch full Edge objects with metadata, then reshapes to KB's
 * { entity, relationship, direction, confidence, rationale } shape.
 *
 * Bridges KB integer entityId ↔ Cortex UUID via the entities table's
 * `arcana_entity_id` column. Skips 'co-occurred' edges to match KB filter
 * (entity-graph.ts:869).
 *
 * Returns null when:
 *  - Cortex singleton not initialised (caller falls through to local)
 *  - The KB entity has no `arcana_entity_id` (not mirrored — can't query Cortex)
 */
export async function getTypedRelationshipsViaCortex(
  root: string,
  entityId: number,
): Promise<Array<{
  entity: Entity;
  relationship: RelationshipType;
  direction: 'outgoing' | 'incoming';
  confidence: number;
  rationale?: string;
}> | null> {
  const cortex = getCortexInstance();
  if (!cortex) return null;

  try {
    const db = await getEntityGraphDb(root);
    const srcRow = db
      .prepare('SELECT arcana_entity_id FROM entities WHERE id = ?')
      .get(entityId) as { arcana_entity_id: string | null } | undefined;
    const srcCortexId = srcRow?.arcana_entity_id ?? null;
    if (!srcCortexId) return null;

    const edges = await cortex.providers.structured.getEdgesFor({
      type: 'entity',
      id: srcCortexId,
    });

    const results: Array<{
      entity: Entity;
      relationship: RelationshipType;
      direction: 'outgoing' | 'incoming';
      confidence: number;
      rationale?: string;
    }> = [];

    for (const edge of edges) {
      if (edge.relation === 'co-occurred') continue;

      const isOutgoing = edge.from.id === srcCortexId;
      const otherCortexId = isOutgoing ? edge.to.id : edge.from.id;
      const otherType = isOutgoing ? edge.to.type : edge.from.type;
      if (otherType !== 'entity') continue;

      const otherRow = db
        .prepare(
          'SELECT id, name, normalized_name, type, aliases, first_seen, last_seen, mention_count, arcana_entity_id FROM entities WHERE arcana_entity_id = ?'
        )
        .get(otherCortexId) as
        | {
            id: number;
            name: string;
            normalized_name: string;
            type: EntityType;
            aliases: string;
            first_seen: string;
            last_seen: string;
            mention_count: number;
            arcana_entity_id: string;
          }
        | undefined;
      if (!otherRow) continue;

      results.push({
        entity: {
          ...otherRow,
          aliases: JSON.parse(otherRow.aliases),
        },
        relationship: edge.relation as RelationshipType,
        direction: isOutgoing ? 'outgoing' : 'incoming',
        confidence: edge.confidence,
        ...(edge.rationale ? { rationale: edge.rationale } : {}),
      });
    }

    // Match KB's ordering: confidence DESC
    results.sort((a, b) => b.confidence - a.confidence);
    return results;
  } catch (err) {
    logger.warn('Cortex getEdgesFor failed; caller will fall back to local', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * FNV-1a 32-bit hash of a UUID string, clamped to positive int. Deterministic
 * for a given UUID. Collisions are theoretically possible but vanishingly
 * unlikely at the scale of a single user's brain. Used wherever KyberBot
 * callers expect a `number` id but the source data is a Cortex UUID.
 */
function hashUuidToInt(uuid: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < uuid.length; i++) {
    h ^= uuid.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Clamp to positive int32 — SQLite INTEGER columns are 64-bit, so this is safe.
  return h & 0x7fffffff;
}

function mapCortexFactSourceToKb(
  source: 'direct_facts' | 'entity_expansion' | 'graph_expansion' | 'bridge',
): 'direct' | 'entity_expansion' | 'graph_expansion' | 'scene_expansion' | 'bridge' {
  switch (source) {
    case 'direct_facts': return 'direct';
    case 'entity_expansion': return 'entity_expansion';
    case 'graph_expansion': return 'graph_expansion';
    case 'bridge': return 'bridge';
  }
}
