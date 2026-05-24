/**
 * Cortex read-parity harness — Harness 2 per the data-parity matrix.
 *
 * Tests five read methods: hybridSearch, getFactsForEntity, listEntities,
 * getNeighbors, getEntityProfile.
 *
 * Seeding strategy: stand up a temp KB dir AND a temp Cortex singleton,
 * then seed facts + entities + memories + edges via KB's dual-write paths:
 *   - storeFact           → mirrors to Cortex via mirrorFactToCortex
 *   - findOrCreateEntity  → mirrors to Cortex via mirrorEntityToCortex
 *   - addToTimeline       → mirrors to Cortex via mirrorToCortex
 *   - linkEntities        → mirrors to Cortex via mirrorLinkToCortex / command.linkNodes
 *
 * Both sides are seeded identically (from the same call), so any divergence
 * reflects implementation difference, not data drift.
 *
 * Known expected residuals (Gap A/B/C per 2026-05-24 KBOT → CORTEX GAPS comms):
 *   - Gap A: Cortex Entity lacks mentionCount → getMostMentionedEntities ordering diverges.
 *   - Gap C: Cortex Edge lacks confidence/method/rationale → getNeighbors shape gap.
 *   - getEntityProfile: KB profiles are sleep-populated (not present at seed time);
 *     Cortex generates on demand via LLM (fake in harness). Structural divergence expected.
 *
 * Plan: docs/plans/2026-05-24-data-parity-matrix.md §Harness 2
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createLibsqlStructuredStore } from '@kybernesis/cortex-provider-libsql';
import {
  createFakeEmbeddingProvider,
  createFakeLLMProvider,
  createFakeVectorStore,
  runParityHarness,
  type ParityReport,
} from '@kybernesis/cortex-testkit';

import { ensureFactsTable, storeFact } from './fact-store.js';
import { getTimelineDb } from './timeline.js';
import { addToTimeline, resetTimelineDb } from './timeline.js';
import {
  initializeEntityGraph,
  findOrCreateEntity,
  linkEntities,
  getTypedRelationships,
  getMostMentionedEntities,
  getRecentEntities,
  getEntityProfile,
  resetEntityGraphDb,
} from './entity-graph.js';
import { getFactsForEntity } from './fact-store.js';
import { hybridSearch } from './hybrid-search.js';
import {
  initCortex,
  disposeCortex,
  getCortexInstance,
  resetCortexForTests,
} from './cortex-singleton.js';
import {
  PARITY_FACTS,
  PARITY_ENTITIES,
  PARITY_EDGES,
  PARITY_MEMORIES,
  PARITY_MEMORY_QUERIES,
  PARITY_ENTITY_QUERIES,
  type ParityEntityQueryFixture,
  type ParityMemoryQueryFixture,
} from './__fixtures__/parity-facts.js';
import { createLogger } from '../logger.js';

const logger = createLogger('read-parity');

export interface ReadParityOptions {
  /** Top-N comparison depth. Default 10. */
  topN?: number;
  /** Pass threshold (0..1). Default 0.95 per matrix plan. */
  threshold?: number;
}

export interface EntityProfileCheck {
  entity: string;
  kbHasProfile: boolean;
  cortexHasProfile: boolean;
  cortexFactCount: number;
}

export interface ReadParityRun {
  hybridSearch: ParityReport<string>;
  getFactsForEntity: ParityReport<string>;
  listEntities: ParityReport<string>;
  getNeighbors: ParityReport<string>;
  getEntityProfile: EntityProfileCheck[];
  seeding: {
    facts: number;
    entities: number;
    memories: number;
    edges: number;
    unmirroredFacts: string[];
    unmirroredEntities: string[];
    unmirroredMemories: string[];
    unmirroredEdges: string[];
  };
  threshold: number;
  topN: number;
  /** True when all four measurable methods pass at >= threshold. getEntityProfile excluded. */
  passes: boolean;
  meanOverlap: number;
}

export async function runReadParity(
  opts: ReadParityOptions = {}
): Promise<ReadParityRun> {
  const topN = opts.topN ?? 10;
  const threshold = opts.threshold ?? 0.95;

  const tempRoot = await mkdtemp(join(tmpdir(), 'kyberbot-read-parity-'));
  logger.info('read-parity harness — temp root', { tempRoot });

  if (getCortexInstance()) {
    await rm(tempRoot, { recursive: true, force: true });
    throw new Error(
      'Cortex singleton already initialised — refusing to overwrite. ' +
      'Run the read-parity harness in a standalone CLI invocation.'
    );
  }

  const structured = createLibsqlStructuredStore(join(tempRoot, 'data', 'arcana.db'));
  await structured.connect();

  try {
    await initCortex({
      structured,
      vector: createFakeVectorStore(),
      embed: createFakeEmbeddingProvider(),
      llm: createFakeLLMProvider(),
    });
    const cortex = getCortexInstance()!;

    // ── Set up KB tables ──────────────────────────────────────────────────────
    await ensureFactsTable(tempRoot);
    await initializeEntityGraph(tempRoot);
    // timeline db is initialised lazily on first addToTimeline call

    // ── Seed facts (dual-write via storeFact) ─────────────────────────────────
    const factFixtureIdToKbId = new Map<string, number>();
    const unmirroredFacts: string[] = [];

    for (const f of PARITY_FACTS) {
      const kbId = await storeFact(tempRoot, {
        content: f.content,
        source_path: `/parity-fact/${f.id}`,
        source_conversation_id: `parity-conv-${f.id}`,
        entities: [...f.entities],
        timestamp: f.timestamp,
        confidence: f.confidence,
        category: f.category,
      });
      factFixtureIdToKbId.set(f.id, kbId);
    }

    // Build fact id maps
    const db = await getTimelineDb(tempRoot);
    const kbFactIdToFixtureId = new Map<number, string>();
    const arcanaFactIdToFixtureId = new Map<string, string>();

    for (const [fixtureId, kbId] of factFixtureIdToKbId) {
      kbFactIdToFixtureId.set(kbId, fixtureId);
      const row = db
        .prepare('SELECT arcana_fact_id FROM facts WHERE id = ?')
        .get(kbId) as { arcana_fact_id: string | null } | undefined;
      const arcanaId = row?.arcana_fact_id ?? null;
      if (arcanaId) {
        arcanaFactIdToFixtureId.set(arcanaId, fixtureId);
      } else {
        unmirroredFacts.push(fixtureId);
      }
    }

    // ── Seed entities (dual-write via findOrCreateEntity) ─────────────────────
    const entityFixtureIdToKbId = new Map<string, number>();
    const entityNameToKbId = new Map<string, number>();
    const entityNameToCortexId = new Map<string, string>();
    const cortexEntityIdToName = new Map<string, string>();
    const unmirroredEntities: string[] = [];

    for (const e of PARITY_ENTITIES) {
      const entity = await findOrCreateEntity(tempRoot, e.name, e.type, e.timestamp);
      entityFixtureIdToKbId.set(e.id, entity.id);
      entityNameToKbId.set(e.name, entity.id);
      if (entity.arcana_entity_id) {
        entityNameToCortexId.set(e.name, entity.arcana_entity_id);
        cortexEntityIdToName.set(entity.arcana_entity_id, e.name);
      } else {
        unmirroredEntities.push(e.id);
      }
    }

    // ── Seed edges (dual-write via linkEntities) ───────────────────────────────
    const unmirroredEdges: string[] = [];
    const entityGraphDb = await (await import('./entity-graph.js')).getEntityGraphDb(tempRoot);

    for (const edge of PARITY_EDGES) {
      const sourceKbId = entityFixtureIdToKbId.get(edge.sourceFixtureId);
      const targetKbId = entityFixtureIdToKbId.get(edge.targetFixtureId);
      if (sourceKbId == null || targetKbId == null) {
        unmirroredEdges.push(edge.id);
        continue;
      }
      await linkEntities(tempRoot, sourceKbId, targetKbId, edge.relationship);
      // Verify edge was mirrored
      const [id1, id2] = sourceKbId < targetKbId ? [sourceKbId, targetKbId] : [targetKbId, sourceKbId];
      const edgeRow = entityGraphDb
        .prepare('SELECT arcana_edge_id FROM entity_relations WHERE source_id = ? AND target_id = ?')
        .get(id1, id2) as { arcana_edge_id: string | null } | undefined;
      if (!edgeRow?.arcana_edge_id) {
        unmirroredEdges.push(edge.id);
      }
    }

    // ── Seed memories (dual-write via addToTimeline) ───────────────────────────
    const memorySourcePathToFixtureId = new Map<string, string>();
    const arcanaMemoryIdToFixtureId = new Map<string, string>();
    const unmirroredMemories: string[] = [];

    for (const m of PARITY_MEMORIES) {
      const sourcePath = `/parity-memory/${m.id}`;
      await addToTimeline(tempRoot, {
        type: m.type,
        timestamp: m.timestamp,
        title: m.title,
        summary: m.summary,
        source_path: sourcePath,
        entities: [...m.entities],
        topics: [...m.topics],
      });
      memorySourcePathToFixtureId.set(sourcePath, m.id);
    }

    // Read arcana_memory_id for each seeded memory
    const timelineDb = await getTimelineDb(tempRoot);
    for (const [sourcePath, fixtureId] of memorySourcePathToFixtureId) {
      const row = timelineDb
        .prepare('SELECT arcana_memory_id FROM timeline_events WHERE source_path = ?')
        .get(sourcePath) as { arcana_memory_id: string | null } | undefined;
      const arcanaId = row?.arcana_memory_id ?? null;
      if (arcanaId) {
        arcanaMemoryIdToFixtureId.set(arcanaId, fixtureId);
      } else {
        unmirroredMemories.push(fixtureId);
      }
    }

    // ── Method 1: hybridSearch ────────────────────────────────────────────────
    type MemoryOutput = { memIds: string[] };

    const hybridBaseline = async (input: unknown): Promise<MemoryOutput> => {
      const q = input as ParityMemoryQueryFixture;
      const results = await hybridSearch(q.query, tempRoot, { limit: topN });
      const memIds: string[] = [];
      for (const r of results) {
        const fid = memorySourcePathToFixtureId.get(r.source_path);
        if (fid) memIds.push(fid);
      }
      return { memIds };
    };

    const hybridCandidate = async (input: unknown): Promise<MemoryOutput> => {
      const q = input as ParityMemoryQueryFixture;
      const qr = await cortex.retrieve.hybridSearch({ query: q.query, topK: topN });
      const memIds: string[] = [];
      for (const row of qr.data) {
        const fid = arcanaMemoryIdToFixtureId.get(row.memory.id);
        if (fid) memIds.push(fid);
      }
      return { memIds };
    };

    const hybridReport = await runParityHarness<MemoryOutput, string>({
      queries: PARITY_MEMORY_QUERIES.map(q => ({ id: q.id, input: q })),
      baseline: hybridBaseline,
      candidate: hybridCandidate,
      extractIds: (r) => r.memIds,
      topN,
      threshold,
    });

    // ── Method 2: getFactsForEntity ───────────────────────────────────────────
    type FactOutput = { factIds: string[] };

    // Use full fixture count as limit so ordering differences don't produce
    // artificial top-N misses (Alice has 12 matching facts in the 31-fact fixture).
    const entityFactLimit = PARITY_FACTS.length;

    const factsEntityBaseline = async (input: unknown): Promise<FactOutput> => {
      const q = input as ParityEntityQueryFixture;
      const facts = await getFactsForEntity(tempRoot, q.entityName, { latestOnly: false, limit: entityFactLimit });
      const factIds: string[] = [];
      for (const f of facts) {
        const fid = kbFactIdToFixtureId.get(f.id);
        if (fid) factIds.push(fid);
      }
      return { factIds };
    };

    const factsEntityCandidate = async (input: unknown): Promise<FactOutput> => {
      const q = input as ParityEntityQueryFixture;
      const facts = await cortex.providers.structured.getFactsForEntity(
        q.entityName,
        undefined,
        undefined,
        false, // latestOnly false — same as baseline
      );
      const factIds: string[] = [];
      for (const f of facts.slice(0, entityFactLimit)) {
        const fid = arcanaFactIdToFixtureId.get(f.id);
        if (fid) factIds.push(fid);
      }
      return { factIds };
    };

    const factsEntityReport = await runParityHarness<FactOutput, string>({
      queries: PARITY_ENTITY_QUERIES.map(q => ({ id: q.id, input: q })),
      baseline: factsEntityBaseline,
      candidate: factsEntityCandidate,
      extractIds: (r) => r.factIds,
      topN: entityFactLimit,
      threshold,
    });

    // ── Method 3: listEntities ────────────────────────────────────────────────
    // Tests: do both sides report the same set of seeded entity names?
    // Known residual (Gap A): ordering by mention_count will diverge because
    // Cortex Entity lacks mentionCount. We compare as a name-set, not ordered list.
    type EntityOutput = { names: string[] };

    const listEntitiesBaseline = async (_input: unknown): Promise<EntityOutput> => {
      const entities = await getMostMentionedEntities(tempRoot, { limit: 20 });
      return { names: entities.map(e => e.name) };
    };

    const listEntitiesCandidate = async (_input: unknown): Promise<EntityOutput> => {
      const entities = await cortex.providers.structured.listEntities({ limit: 20 });
      return { names: entities.map((e: { name: string }) => e.name) };
    };

    const listEntitiesReport = await runParityHarness<EntityOutput, string>({
      queries: [{ id: 'all-entities', input: {} }],
      baseline: listEntitiesBaseline,
      candidate: listEntitiesCandidate,
      extractIds: (r) => r.names,
      topN: PARITY_ENTITIES.length,
      threshold,
    });

    // ── Method 4: getNeighbors ────────────────────────────────────────────────
    // KB uses getTypedRelationships (filters out co-occurred).
    // Cortex uses providers.structured.getNeighbors (all edges, undirected).
    // Since we only seeded typed edges (no co-occurred), sets should match.
    // Known residual (Gap C): edge metadata shape differs — not compared here.
    type NeighborOutput = { neighborNames: string[] };

    const neighborsBaseline = async (input: unknown): Promise<NeighborOutput> => {
      const q = input as ParityEntityQueryFixture;
      const kbId = entityNameToKbId.get(q.entityName);
      if (kbId == null) return { neighborNames: [] };
      const rels = await getTypedRelationships(tempRoot, kbId);
      return { neighborNames: rels.map(r => r.entity.name) };
    };

    const neighborsCandidate = async (input: unknown): Promise<NeighborOutput> => {
      const q = input as ParityEntityQueryFixture;
      const cortexId = entityNameToCortexId.get(q.entityName);
      if (!cortexId) return { neighborNames: [] };
      const qr = await cortex.providers.structured.getNeighbors(
        { type: 'entity', id: cortexId },
        1,
      );
      const neighborNames: string[] = [];
      for (const nodeRef of qr) {
        const name = cortexEntityIdToName.get(nodeRef.id);
        if (name) neighborNames.push(name);
      }
      return { neighborNames };
    };

    const neighborsReport = await runParityHarness<NeighborOutput, string>({
      queries: PARITY_ENTITY_QUERIES.map(q => ({ id: q.id, input: q })),
      baseline: neighborsBaseline,
      candidate: neighborsCandidate,
      extractIds: (r) => r.neighborNames,
      topN: PARITY_EDGES.length,
      threshold,
    });

    // ── Method 5: getEntityProfile (structural check, not in pass gate) ───────
    // KB profiles are sleep-populated — none exist at seed time.
    // Cortex generates on demand via LLM (fake in harness → stub response).
    // Divergence is expected and documented. Reported for completeness only.
    const profileChecks: EntityProfileCheck[] = [];

    for (const eq of PARITY_ENTITY_QUERIES) {
      const kbId = entityNameToKbId.get(eq.entityName);
      const kbProfile = kbId != null ? await getEntityProfile(tempRoot, kbId) : null;

      let cortexHasProfile = false;
      let cortexFactCount = 0;
      try {
        const cortexQr = await cortex.retrieve.getEntityProfile(eq.entityName);
        if (cortexQr.data) {
          cortexHasProfile = Boolean(cortexQr.data.narrativeProse || cortexQr.data.dynamicContext);
          cortexFactCount = cortexQr.data.staticFacts?.length ?? 0;
        }
      } catch {
        // Fake LLM may throw; treat as no profile
      }

      profileChecks.push({
        entity: eq.entityName,
        kbHasProfile: Boolean(kbProfile?.profile),
        cortexHasProfile,
        cortexFactCount,
      });
    }

    // ── Aggregate ─────────────────────────────────────────────────────────────
    const methodOverlaps = [
      hybridReport.meanOverlap,
      factsEntityReport.meanOverlap,
      listEntitiesReport.meanOverlap,
      neighborsReport.meanOverlap,
    ];
    const meanOverlap = methodOverlaps.reduce((s, v) => s + v, 0) / methodOverlaps.length;
    const passes =
      hybridReport.passes &&
      factsEntityReport.passes &&
      listEntitiesReport.passes &&
      neighborsReport.passes;

    return {
      hybridSearch: hybridReport,
      getFactsForEntity: factsEntityReport,
      listEntities: listEntitiesReport,
      getNeighbors: neighborsReport,
      getEntityProfile: profileChecks,
      seeding: {
        facts: PARITY_FACTS.length,
        entities: PARITY_ENTITIES.length,
        memories: PARITY_MEMORIES.length,
        edges: PARITY_EDGES.length,
        unmirroredFacts,
        unmirroredEntities,
        unmirroredMemories,
        unmirroredEdges,
      },
      threshold,
      topN,
      passes,
      meanOverlap,
    };
  } finally {
    await disposeCortex().catch((err) => {
      logger.warn('disposeCortex failed during read-parity teardown', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    resetCortexForTests();
    resetEntityGraphDb(tempRoot);
    resetTimelineDb(tempRoot);
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export function formatReadParityReport(run: ReadParityRun): string {
  const lines: string[] = [];
  lines.push('Cortex read parity report (Harness 2)');
  lines.push('─'.repeat(60));
  lines.push(`seeded:  ${run.seeding.facts} facts, ${run.seeding.entities} entities, ${run.seeding.memories} memories, ${run.seeding.edges} edges`);
  if (run.seeding.unmirroredFacts.length > 0)    lines.push(`  unmirrored facts:    ${run.seeding.unmirroredFacts.join(', ')}`);
  if (run.seeding.unmirroredEntities.length > 0) lines.push(`  unmirrored entities: ${run.seeding.unmirroredEntities.join(', ')}`);
  if (run.seeding.unmirroredMemories.length > 0) lines.push(`  unmirrored memories: ${run.seeding.unmirroredMemories.join(', ')}`);
  if (run.seeding.unmirroredEdges.length > 0)    lines.push(`  unmirrored edges:    ${run.seeding.unmirroredEdges.join(', ')}`);
  lines.push(`top-N:   ${run.topN}`);
  lines.push(`threshold: ${run.threshold}`);
  lines.push(`mean overlap (4 methods): ${run.meanOverlap.toFixed(3)}`);
  lines.push(`verdict: ${run.passes ? 'PASS' : 'FAIL'}`);
  lines.push('');

  const printMethod = (name: string, report: ParityReport<string>, note?: string) => {
    lines.push(`── ${name}`);
    lines.push(`   mean: ${report.meanOverlap.toFixed(3)}  verdict: ${report.passes ? 'PASS' : 'FAIL'}${note ? `  [${note}]` : ''}`);
    for (const q of report.perQuery) {
      const tag = q.error ? `ERROR(${q.error.side})` : q.overlap.toFixed(2);
      lines.push(`   ${q.queryId.padEnd(20)} ${tag}`);
      if (q.error) {
        lines.push(`     error: ${q.error.message}`);
      } else if (q.overlap < 1) {
        if (q.missingFromCandidate.length > 0) lines.push(`     missing from cortex: ${q.missingFromCandidate.join(', ')}`);
        if (q.extraInCandidate.length > 0)     lines.push(`     extra in cortex:     ${q.extraInCandidate.join(', ')}`);
      }
    }
  };

  printMethod('hybridSearch', run.hybridSearch);
  lines.push('');
  printMethod('getFactsForEntity', run.getFactsForEntity);
  lines.push('');
  printMethod('listEntities (getMostMentioned vs listEntities)', run.listEntities, 'Gap A: ordering diverges; set-equality tested');
  lines.push('');
  printMethod('getNeighbors (getTypedRelationships vs getNeighbors)', run.getNeighbors, 'Gap C: edge metadata not compared');
  lines.push('');

  lines.push('── getEntityProfile (structural — not in pass gate)');
  lines.push('   Note: KB profiles are sleep-populated; none exist at seed time.');
  lines.push('   Cortex generates on-demand via LLM (fake in harness → stub).');
  for (const p of run.getEntityProfile) {
    lines.push(`   ${p.entity.padEnd(14)} kb=${p.kbHasProfile ? 'yes' : 'no '}  cortex=${p.cortexHasProfile ? 'yes' : 'no '} (cortexFactCount=${p.cortexFactCount})`);
  }

  return lines.join('\n');
}
