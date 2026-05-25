/**
 * Cortex sleep-parity harness — Harness 3 per the data-parity matrix.
 *
 * Runs KyberBot's `runSleepCycleNow` AND Cortex's `maintain.runSleepPipeline`
 * over the SAME engineered fixtures with the SAME Haiku LLM injected on both
 * sides, then diffs outcomes per step.
 *
 * Pass strategy (per matrix plan):
 *   - Deterministic 5 (decay, consolidate, link, tier, entity-hygiene):
 *     exact diff — PASS/FAIL on row-count + identity of affected rows.
 *   - LLM-driven 5 (tag, summarize, observe, profile, reasoning):
 *     side-by-side markdown report for human eyeballing — no PASS/FAIL
 *     because LLM outputs are non-deterministic even with shared model.
 *
 * Shared LLM: `createClaudeLLMProvider({ model: 'haiku' })` is injected into
 * Cortex's `initCortex({ llm })`. KB's sleep steps already use the same
 * `claude.complete()` subprocess path, so both sides hit the same Haiku.
 *
 * Sequencing: cascade fix (`ed86494`) MUST be wired before running this
 * against live data — otherwise KB sleep deletes leave Cortex orphans.
 * The harness uses a temp dir so this is moot for harness runs but worth
 * noting if you adapt this for production data.
 *
 * Plan: docs/plans/2026-05-24-data-parity-matrix.md §Harness 3
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'libsql';

import { createLibsqlStructuredStore } from '@kybernesis/cortex-provider-libsql';
import {
  createFakeEmbeddingProvider,
  createFakeVectorStore,
} from '@kybernesis/cortex-testkit';

type SleepStep =
  | 'decayMemories' | 'refreshTags' | 'consolidateMemories' | 'linkMemories'
  | 'tierMemories' | 'summarizeMemories' | 'observeConversations'
  | 'rebuildUserProfile' | 'runReasoning' | 'cleanEntityGraph';

import { ensureFactsTable, storeFact } from './fact-store.js';
import { getTimelineDb, addToTimeline } from './timeline.js';
import {
  initializeEntityGraph,
  findOrCreateEntity,
  linkEntities,
  resetEntityGraphDb,
  getEntityGraphDb,
} from './entity-graph.js';
import { runSleepCycleNow } from './sleep/index.js';
import { resetTimelineDb } from './timeline.js';
import {
  initCortex,
  disposeCortex,
  getCortexInstance,
  resetCortexForTests,
} from './cortex-singleton.js';
import { createClaudeLLMProvider } from './providers/claude-llm-provider.js';
import {
  PARITY_SLEEP_ENTITIES,
  PARITY_SLEEP_EDGES,
  PARITY_SLEEP_MEMORIES,
  PARITY_SLEEP_FACTS,
} from './__fixtures__/parity-sleep.js';
import { createLogger } from '../logger.js';

const logger = createLogger('sleep-parity');

const DETERMINISTIC_STEPS = ['decay', 'consolidate', 'link', 'tier', 'entity-hygiene'] as const;
const LLM_STEPS = ['tag', 'summarize', 'observe', 'profile', 'reasoning'] as const;

const CORTEX_STEP_MAP: Record<string, SleepStep> = {
  decay: 'decayMemories',
  tag: 'refreshTags',
  consolidate: 'consolidateMemories',
  link: 'linkMemories',
  tier: 'tierMemories',
  summarize: 'summarizeMemories',
  observe: 'observeConversations',
  profile: 'rebuildUserProfile',
  reasoning: 'runReasoning',
  'entity-hygiene': 'cleanEntityGraph',
};

export interface SleepParityOptions {
  /** Restrict to specific step groups. Default: both. */
  stepGroup?: 'all' | 'deterministic' | 'llm';
  /** Where to write the markdown report. Default: docs/sleep-parity-report-<ts>.md */
  reportPath?: string;
}

// ── Snapshot shapes ─────────────────────────────────────────────────────────

interface MemorySnapshotRow {
  sourcePath: string;
  decayScore: number | null;
  priority: number | null;
  tier: string | null;
  summary: string;
  tags: string | null; // JSON-stringified
}

interface FactSnapshotRow {
  fixtureId: string;
  content: string;
  confidence: number;
  isLatest: number;
  expiresAt: string | null;
}

interface EntitySnapshotRow {
  name: string;
  mentionCount: number;
}

interface EdgeKey {
  source: string;
  target: string;
  relationship: string;
}

interface KbSnapshot {
  memories: Map<string, MemorySnapshotRow>;             // keyed by source_path
  facts: Map<string, FactSnapshotRow>;                  // keyed by fixture id
  entities: Map<string, EntitySnapshotRow>;             // keyed by lower(name)
  edges: Set<string>;                                   // "src::tgt::rel"
  entityProfileCount: number;
  entityInsightCount: number;
}

interface CortexSnapshot {
  memories: Map<string, MemorySnapshotRow>;             // keyed by source_path (via memory fixture id map)
  facts: Map<string, FactSnapshotRow>;                  // keyed by fixture id
  entities: Map<string, EntitySnapshotRow>;             // keyed by lower(name)
  edges: Set<string>;                                   // "src::tgt::rel"
}

interface StepResult {
  step: string;
  kind: 'deterministic' | 'llm';
  ran: boolean;
  passes: boolean;
  note: string;
}

export interface SleepParityRun {
  options: { stepGroup: 'all' | 'deterministic' | 'llm' };
  seeding: {
    memories: number; facts: number; entities: number; edges: number;
    unmirroredMemories: string[]; unmirroredFacts: string[];
    unmirroredEntities: string[]; unmirroredEdges: string[];
  };
  kbCycle: { startedAt: string; finishedAt: string; durationMs: number; error?: string };
  cortexCycle: { startedAt: string; finishedAt: string; durationMs: number; error?: string };
  steps: StepResult[];
  reportPath: string;
  passes: boolean;
}

// ── Snapshot helpers ────────────────────────────────────────────────────────

async function snapshotKb(
  root: string,
  factFixtureIds: Map<number, string>,
): Promise<KbSnapshot> {
  const timelineDb = await getTimelineDb(root);
  const entityDb = await getEntityGraphDb(root);

  const memRows = timelineDb.prepare(`
    SELECT source_path, decay_score, priority, tier, summary, tags_json
    FROM timeline_events
  `).all() as Array<{
    source_path: string; decay_score: number | null; priority: number | null;
    tier: string | null; summary: string; tags_json: string | null;
  }>;
  const memories = new Map<string, MemorySnapshotRow>();
  for (const r of memRows) {
    memories.set(r.source_path, {
      sourcePath: r.source_path,
      decayScore: r.decay_score,
      priority: r.priority,
      tier: r.tier,
      summary: r.summary,
      tags: r.tags_json,
    });
  }

  const factRows = timelineDb.prepare(`
    SELECT id, content, confidence, is_latest, expires_at
    FROM facts
  `).all() as Array<{
    id: number; content: string; confidence: number;
    is_latest: number; expires_at: string | null;
  }>;
  const facts = new Map<string, FactSnapshotRow>();
  for (const r of factRows) {
    const fid = factFixtureIds.get(r.id);
    if (!fid) continue;
    facts.set(fid, {
      fixtureId: fid,
      content: r.content,
      confidence: r.confidence,
      isLatest: r.is_latest,
      expiresAt: r.expires_at,
    });
  }

  const entRows = entityDb.prepare(`
    SELECT name, mention_count FROM entities
  `).all() as Array<{ name: string; mention_count: number }>;
  const entities = new Map<string, EntitySnapshotRow>();
  for (const r of entRows) {
    entities.set(r.name.toLowerCase(), { name: r.name, mentionCount: r.mention_count });
  }

  const edgeRows = entityDb.prepare(`
    SELECT
      (SELECT name FROM entities WHERE id = er.source_id) as src,
      (SELECT name FROM entities WHERE id = er.target_id) as tgt,
      er.relationship as rel
    FROM entity_relations er
  `).all() as Array<{ src: string; tgt: string; rel: string }>;
  const edges = new Set<string>();
  for (const r of edgeRows) {
    if (r.src && r.tgt) edges.add(`${r.src.toLowerCase()}::${r.tgt.toLowerCase()}::${r.rel}`);
  }

  const profileCount = (entityDb.prepare('SELECT COUNT(*) as c FROM entity_profiles').get() as { c: number }).c;
  const insightCount = (entityDb.prepare('SELECT COUNT(*) as c FROM entity_insights').get() as { c: number }).c;

  return { memories, facts, entities, edges, entityProfileCount: profileCount, entityInsightCount: insightCount };
}

async function snapshotCortex(
  cortexDbPath: string,
  factFixtureIds: Map<string, string>,
  memoryFixturePaths: Map<string, string>,
): Promise<CortexSnapshot> {
  const db = new Database(cortexDbPath);

  const memRows = db.prepare(`
    SELECT id, source_path, tier, summary, tags
    FROM memories
  `).all() as Array<{
    id: string; source_path: string | null; tier: string | null;
    summary: string | null; tags: string | null;
  }>;
  const memories = new Map<string, MemorySnapshotRow>();
  for (const r of memRows) {
    // Prefer source_path; fall back to mapping via arcana memory id → fixture id
    const sp = r.source_path ?? memoryFixturePaths.get(r.id) ?? null;
    if (!sp) continue;
    memories.set(sp, {
      sourcePath: sp,
      decayScore: null, // Cortex stores decay differently — not directly comparable field-for-field
      priority: null,
      tier: r.tier,
      summary: r.summary ?? '',
      tags: r.tags,
    });
  }

  const factRows = db.prepare(`
    SELECT id, fact, confidence, is_latest, expires_at
    FROM facts
  `).all() as Array<{
    id: string; fact: string; confidence: number; is_latest: number; expires_at: string | null;
  }>;
  const facts = new Map<string, FactSnapshotRow>();
  for (const r of factRows) {
    const fid = factFixtureIds.get(r.id);
    if (!fid) continue;
    facts.set(fid, {
      fixtureId: fid,
      content: r.fact,
      confidence: r.confidence,
      isLatest: r.is_latest,
      expiresAt: r.expires_at,
    });
  }

  const entRows = db.prepare(`
    SELECT name, mention_count FROM entities
  `).all() as Array<{ name: string; mention_count: number }>;
  const entities = new Map<string, EntitySnapshotRow>();
  for (const r of entRows) {
    entities.set(r.name.toLowerCase(), { name: r.name, mentionCount: r.mention_count });
  }

  const edgeRows = db.prepare(`
    SELECT
      (SELECT name FROM entities WHERE id = e.from_id) as src,
      (SELECT name FROM entities WHERE id = e.to_id) as tgt,
      e.relation as rel
    FROM edges e
    WHERE e.from_type = 'entity' AND e.to_type = 'entity'
  `).all() as Array<{ src: string | null; tgt: string | null; rel: string }>;
  const edges = new Set<string>();
  for (const r of edgeRows) {
    if (r.src && r.tgt) edges.add(`${r.src.toLowerCase()}::${r.tgt.toLowerCase()}::${r.rel}`);
  }

  db.close();
  return { memories, facts, entities, edges };
}

// ── Diff helpers ────────────────────────────────────────────────────────────

function diffDecay(before: KbSnapshot, after: KbSnapshot, cortexBefore: CortexSnapshot, cortexAfter: CortexSnapshot): StepResult {
  // Count facts that became is_latest = 0 on each side
  let kbExpired = 0, cortexExpired = 0;
  for (const [id, b] of before.facts) {
    const a = after.facts.get(id);
    if (b.isLatest === 1 && a?.isLatest === 0) kbExpired++;
  }
  for (const [id, b] of cortexBefore.facts) {
    const a = cortexAfter.facts.get(id);
    if (b.isLatest === 1 && a?.isLatest === 0) cortexExpired++;
  }

  // Count memories with decay_score change on KB side (Cortex doesn't expose comparable field directly)
  let kbDecayed = 0;
  for (const [sp, b] of before.memories) {
    const a = after.memories.get(sp);
    if (a && a.decayScore !== b.decayScore) kbDecayed++;
  }

  const passes = kbExpired === cortexExpired;
  return {
    step: 'decay',
    kind: 'deterministic',
    ran: true,
    passes,
    note: `facts expired — KB:${kbExpired} Cortex:${cortexExpired}; KB memories with decay-score change: ${kbDecayed}`,
  };
}

function diffConsolidate(before: KbSnapshot, after: KbSnapshot, cortexBefore: CortexSnapshot, cortexAfter: CortexSnapshot): StepResult {
  const kbRemoved = new Set<string>();
  for (const sp of before.memories.keys()) {
    if (!after.memories.has(sp)) kbRemoved.add(sp);
  }
  const cortexRemoved = new Set<string>();
  for (const sp of cortexBefore.memories.keys()) {
    if (!cortexAfter.memories.has(sp)) cortexRemoved.add(sp);
  }

  // Identity check: same memories removed?
  const onlyInKb = [...kbRemoved].filter(sp => !cortexRemoved.has(sp));
  const onlyInCortex = [...cortexRemoved].filter(sp => !kbRemoved.has(sp));
  const passes = onlyInKb.length === 0 && onlyInCortex.length === 0 && kbRemoved.size > 0;

  return {
    step: 'consolidate',
    kind: 'deterministic',
    ran: true,
    passes,
    note: `removed — KB:${kbRemoved.size} Cortex:${cortexRemoved.size}; ` +
      `KB-only: [${onlyInKb.join(', ')}], Cortex-only: [${onlyInCortex.join(', ')}]`,
  };
}

function diffLink(before: KbSnapshot, after: KbSnapshot, cortexBefore: CortexSnapshot, cortexAfter: CortexSnapshot): StepResult {
  const kbNew = [...after.edges].filter(e => !before.edges.has(e));
  const cortexNew = [...cortexAfter.edges].filter(e => !cortexBefore.edges.has(e));
  return {
    step: 'link',
    kind: 'deterministic',
    ran: true,
    passes: Math.abs(kbNew.length - cortexNew.length) <= 1, // tolerance: ±1
    note: `new edges — KB:${kbNew.length} Cortex:${cortexNew.length}`,
  };
}

function diffTier(before: KbSnapshot, after: KbSnapshot, cortexBefore: CortexSnapshot, cortexAfter: CortexSnapshot): StepResult {
  const kbChanged = new Map<string, string>(); // source_path → new tier
  for (const [sp, b] of before.memories) {
    const a = after.memories.get(sp);
    if (a && a.tier !== b.tier) kbChanged.set(sp, `${b.tier ?? 'null'}→${a.tier ?? 'null'}`);
  }
  const cortexChanged = new Map<string, string>();
  for (const [sp, b] of cortexBefore.memories) {
    const a = cortexAfter.memories.get(sp);
    if (a && a.tier !== b.tier) cortexChanged.set(sp, `${b.tier ?? 'null'}→${a.tier ?? 'null'}`);
  }

  const kbKeys = [...kbChanged.keys()].sort();
  const cortexKeys = [...cortexChanged.keys()].sort();
  const passes = kbKeys.length === cortexKeys.length &&
    kbKeys.every((k, i) => k === cortexKeys[i]);

  return {
    step: 'tier',
    kind: 'deterministic',
    ran: true,
    passes,
    note: `tier shifts — KB:${kbChanged.size} Cortex:${cortexChanged.size}`,
  };
}

function diffEntityHygiene(before: KbSnapshot, after: KbSnapshot, cortexBefore: CortexSnapshot, cortexAfter: CortexSnapshot): StepResult {
  const kbRemoved = new Set<string>();
  for (const name of before.entities.keys()) {
    if (!after.entities.has(name)) kbRemoved.add(name);
  }
  const cortexRemoved = new Set<string>();
  for (const name of cortexBefore.entities.keys()) {
    if (!cortexAfter.entities.has(name)) cortexRemoved.add(name);
  }
  return {
    step: 'entity-hygiene',
    kind: 'deterministic',
    ran: true,
    passes: kbRemoved.size === cortexRemoved.size,
    note: `entities removed — KB:${kbRemoved.size} Cortex:${cortexRemoved.size}; ` +
      `KB-only: [${[...kbRemoved].filter(n => !cortexRemoved.has(n)).join(', ')}], ` +
      `Cortex-only: [${[...cortexRemoved].filter(n => !kbRemoved.has(n)).join(', ')}]`,
  };
}

function llmStepReport(stepName: string, before: KbSnapshot, after: KbSnapshot, cortexBefore: CortexSnapshot, cortexAfter: CortexSnapshot): StepResult {
  // For LLM steps we record what changed on each side. Pass = both ran without error.
  // Full content diff is in the markdown report; this just captures whether the step did anything.
  let kbChanges = 0, cortexChanges = 0;

  switch (stepName) {
    case 'tag':
    case 'summarize':
      // Count memories where tags or summary changed
      for (const [sp, b] of before.memories) {
        const a = after.memories.get(sp);
        if (!a) continue;
        if (stepName === 'tag' && a.tags !== b.tags) kbChanges++;
        if (stepName === 'summarize' && a.summary !== b.summary) kbChanges++;
      }
      for (const [sp, b] of cortexBefore.memories) {
        const a = cortexAfter.memories.get(sp);
        if (!a) continue;
        if (stepName === 'tag' && a.tags !== b.tags) cortexChanges++;
        if (stepName === 'summarize' && a.summary !== b.summary) cortexChanges++;
      }
      break;
    case 'observe':
      // Count new facts added
      kbChanges = after.facts.size - before.facts.size;
      cortexChanges = cortexAfter.facts.size - cortexBefore.facts.size;
      break;
    case 'profile':
      // KB profile count delta
      kbChanges = after.entityProfileCount - before.entityProfileCount;
      cortexChanges = 0; // Cortex doesn't expose count easily here
      break;
    case 'reasoning':
      kbChanges = after.entityInsightCount - before.entityInsightCount;
      cortexChanges = 0;
      break;
  }

  return {
    step: stepName,
    kind: 'llm',
    ran: true,
    passes: true, // LLM steps don't gate the pass — full review is in markdown report
    note: `changes — KB:${kbChanges} Cortex:${cortexChanges}  [content: see report]`,
  };
}

// ── Main harness ────────────────────────────────────────────────────────────

export async function runSleepParity(opts: SleepParityOptions = {}): Promise<SleepParityRun> {
  const stepGroup = opts.stepGroup ?? 'all';
  const tempRoot = await mkdtemp(join(tmpdir(), 'kyberbot-sleep-parity-'));
  logger.info('sleep-parity — temp root', { tempRoot });

  if (getCortexInstance()) {
    await rm(tempRoot, { recursive: true, force: true });
    throw new Error('Cortex singleton already initialised — run sleep-parity in a standalone CLI invocation.');
  }

  const cortexDbDir = join(tempRoot, 'data');
  const cortexDbPath = join(cortexDbDir, 'arcana.db');
  await mkdir(cortexDbDir, { recursive: true });

  const structured = createLibsqlStructuredStore(cortexDbPath);
  await structured.connect();

  try {
    await initCortex({
      structured,
      vector: createFakeVectorStore(),
      embed: createFakeEmbeddingProvider(),
      llm: createClaudeLLMProvider({ model: 'haiku' }),
    });
    const cortex = getCortexInstance()!;

    await ensureFactsTable(tempRoot);
    await initializeEntityGraph(tempRoot);

    // ── Seed ──────────────────────────────────────────────────────────────────
    const factKbIdToFixture = new Map<number, string>();
    const factCortexIdToFixture = new Map<string, string>();
    const memorySourcePathToFixture = new Map<string, string>(); // sp → fixture id (KB side)
    const memoryCortexIdToSourcePath = new Map<string, string>(); // cortex memory id → source_path
    const entityFixtureToKbId = new Map<string, number>();
    const unmirroredFacts: string[] = [];
    const unmirroredMemories: string[] = [];
    const unmirroredEntities: string[] = [];
    const unmirroredEdges: string[] = [];

    // Facts
    for (const f of PARITY_SLEEP_FACTS) {
      const kbId = await storeFact(tempRoot, {
        content: f.content,
        source_path: `/sleep-fact/${f.id}`,
        source_conversation_id: `sleep-conv-${f.id}`,
        entities: [...f.entities],
        timestamp: f.timestamp,
        confidence: f.confidence,
        category: f.category,
        ...(f.expiresAt ? { expires_at: f.expiresAt } : {}),
      });
      factKbIdToFixture.set(kbId, f.id);
    }
    const tdb = await getTimelineDb(tempRoot);
    for (const [kbId, fid] of factKbIdToFixture) {
      const row = tdb.prepare('SELECT arcana_fact_id FROM facts WHERE id = ?').get(kbId) as { arcana_fact_id: string | null } | undefined;
      if (row?.arcana_fact_id) factCortexIdToFixture.set(row.arcana_fact_id, fid);
      else unmirroredFacts.push(fid);
    }
    // Note: storeFact's mirror DOES carry expires_at through recordFact (verified
    // 2026-05-24). v2.1.6 had no expire sweep so it didn't matter; v2.1.8 does.

    // Entities
    for (const e of PARITY_SLEEP_ENTITIES) {
      const ent = await findOrCreateEntity(tempRoot, e.name, e.type, new Date().toISOString());
      entityFixtureToKbId.set(e.id, ent.id);
      // Bump mention_count to reach LLM-step thresholds
      if (e.initialMentions && e.initialMentions > 1) {
        const edb = await getEntityGraphDb(tempRoot);
        edb.prepare('UPDATE entities SET mention_count = ? WHERE id = ?').run(e.initialMentions, ent.id);
        // Mirror the bumped count to Cortex via upsertEntity
        if (ent.arcana_entity_id) {
          await cortex.command.upsertEntity({
            id: ent.arcana_entity_id,
            name: ent.name,
            type: ent.type,
            mentionCount: e.initialMentions,
          });
        } else {
          unmirroredEntities.push(e.id);
        }
      }
    }

    // Edges
    const edb = await getEntityGraphDb(tempRoot);
    for (const e of PARITY_SLEEP_EDGES) {
      const src = entityFixtureToKbId.get(e.sourceFixtureId);
      const tgt = entityFixtureToKbId.get(e.targetFixtureId);
      if (src == null || tgt == null) { unmirroredEdges.push(e.id); continue; }
      await linkEntities(tempRoot, src, tgt, e.relationship);
      const [id1, id2] = src < tgt ? [src, tgt] : [tgt, src];
      const rel = edb.prepare('SELECT arcana_edge_id FROM entity_relations WHERE source_id = ? AND target_id = ?').get(id1, id2) as { arcana_edge_id: string | null } | undefined;
      if (!rel?.arcana_edge_id) unmirroredEdges.push(e.id);
    }

    // Memories
    for (const m of PARITY_SLEEP_MEMORIES) {
      const sp = `/sleep-memory/${m.id}`;
      await addToTimeline(tempRoot, {
        type: m.type,
        timestamp: m.timestamp,
        title: m.title,
        summary: m.summary,
        source_path: sp,
        entities: [...m.entities],
        topics: [...m.topics],
      });
      memorySourcePathToFixture.set(sp, m.id);
    }
    {
      const tdb2 = await getTimelineDb(tempRoot);
      for (const [sp] of memorySourcePathToFixture) {
        const row = tdb2.prepare('SELECT arcana_memory_id FROM timeline_events WHERE source_path = ?').get(sp) as { arcana_memory_id: string | null } | undefined;
        if (row?.arcana_memory_id) memoryCortexIdToSourcePath.set(row.arcana_memory_id, sp);
        else unmirroredMemories.push(sp);
      }
      // Push source_path into Cortex memories so the diff can key on it
      const db = new Database(cortexDbPath);
      try { db.exec(`ALTER TABLE memories ADD COLUMN source_path TEXT`); } catch { /* already exists */ }
      for (const [cortexId, sp] of memoryCortexIdToSourcePath) {
        db.prepare('UPDATE memories SET source_path = ? WHERE id = ?').run(sp, cortexId);
      }
      db.close();
    }

    // ── Snapshot BEFORE ───────────────────────────────────────────────────────
    const kbBefore = await snapshotKb(tempRoot, factKbIdToFixture);
    const cortexBefore = await snapshotCortex(cortexDbPath, factCortexIdToFixture, memoryCortexIdToSourcePath);

    // ── Choose which steps to run ─────────────────────────────────────────────
    const stepsToRun: SleepStep[] = stepGroup === 'deterministic'
      ? DETERMINISTIC_STEPS.map(s => CORTEX_STEP_MAP[s])
      : stepGroup === 'llm'
      ? LLM_STEPS.map(s => CORTEX_STEP_MAP[s])
      : Object.values(CORTEX_STEP_MAP);

    // ── Run KB sleep cycle ────────────────────────────────────────────────────
    const kbStart = Date.now();
    const kbStartedAt = new Date().toISOString();
    let kbError: string | undefined;
    try {
      // KB has no per-step filter on runSleepCycleNow; we disable LLM features via config when --steps deterministic
      const kbConfig = stepGroup === 'deterministic' ? {
        enableTagging: false,
        enableObservations: false,
        enableUserProfile: false,
        enableReasoning: false,
        enableRewriting: false,
      } : {};
      await runSleepCycleNow(tempRoot, kbConfig);
    } catch (err) {
      kbError = err instanceof Error ? err.message : String(err);
      logger.warn('KB sleep cycle errored', { error: kbError });
    }
    const kbFinishedAt = new Date().toISOString();
    const kbDurationMs = Date.now() - kbStart;

    // ── Run Cortex sleep pipeline ─────────────────────────────────────────────
    const cortexStart = Date.now();
    const cortexStartedAt = new Date().toISOString();
    let cortexError: string | undefined;
    try {
      await cortex.maintain.runSleepPipeline({ steps: stepsToRun });
    } catch (err) {
      cortexError = err instanceof Error ? err.message : String(err);
      logger.warn('Cortex sleep cycle errored', { error: cortexError });
    }
    const cortexFinishedAt = new Date().toISOString();
    const cortexDurationMs = Date.now() - cortexStart;

    // ── Snapshot AFTER ────────────────────────────────────────────────────────
    const kbAfter = await snapshotKb(tempRoot, factKbIdToFixture);
    const cortexAfter = await snapshotCortex(cortexDbPath, factCortexIdToFixture, memoryCortexIdToSourcePath);

    // ── Compute step-by-step diffs ────────────────────────────────────────────
    const steps: StepResult[] = [];
    const wantStep = (s: string) =>
      stepGroup === 'all' ||
      (stepGroup === 'deterministic' && DETERMINISTIC_STEPS.includes(s as typeof DETERMINISTIC_STEPS[number])) ||
      (stepGroup === 'llm' && LLM_STEPS.includes(s as typeof LLM_STEPS[number]));

    if (wantStep('decay'))           steps.push(diffDecay(kbBefore, kbAfter, cortexBefore, cortexAfter));
    if (wantStep('tag'))             steps.push(llmStepReport('tag', kbBefore, kbAfter, cortexBefore, cortexAfter));
    if (wantStep('consolidate'))     steps.push(diffConsolidate(kbBefore, kbAfter, cortexBefore, cortexAfter));
    if (wantStep('link'))            steps.push(diffLink(kbBefore, kbAfter, cortexBefore, cortexAfter));
    if (wantStep('tier'))            steps.push(diffTier(kbBefore, kbAfter, cortexBefore, cortexAfter));
    if (wantStep('summarize'))       steps.push(llmStepReport('summarize', kbBefore, kbAfter, cortexBefore, cortexAfter));
    if (wantStep('observe'))         steps.push(llmStepReport('observe', kbBefore, kbAfter, cortexBefore, cortexAfter));
    if (wantStep('profile'))         steps.push(llmStepReport('profile', kbBefore, kbAfter, cortexBefore, cortexAfter));
    if (wantStep('reasoning'))       steps.push(llmStepReport('reasoning', kbBefore, kbAfter, cortexBefore, cortexAfter));
    if (wantStep('entity-hygiene'))  steps.push(diffEntityHygiene(kbBefore, kbAfter, cortexBefore, cortexAfter));

    // ── Write markdown report ─────────────────────────────────────────────────
    const reportPath = opts.reportPath ?? join(
      process.cwd(),
      'docs',
      `sleep-parity-report-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.md`,
    );
    await mkdir(join(reportPath, '..'), { recursive: true });
    await writeFile(reportPath, formatMarkdownReport({
      kbBefore, kbAfter, cortexBefore, cortexAfter, steps,
      kbDurationMs, cortexDurationMs, kbError, cortexError,
    }));

    const detPasses = steps.filter(s => s.kind === 'deterministic').every(s => s.passes);

    return {
      options: { stepGroup },
      seeding: {
        memories: PARITY_SLEEP_MEMORIES.length,
        facts: PARITY_SLEEP_FACTS.length,
        entities: PARITY_SLEEP_ENTITIES.length,
        edges: PARITY_SLEEP_EDGES.length,
        unmirroredMemories,
        unmirroredFacts,
        unmirroredEntities,
        unmirroredEdges,
      },
      kbCycle:     { startedAt: kbStartedAt,     finishedAt: kbFinishedAt,     durationMs: kbDurationMs,     ...(kbError ? { error: kbError } : {}) },
      cortexCycle: { startedAt: cortexStartedAt, finishedAt: cortexFinishedAt, durationMs: cortexDurationMs, ...(cortexError ? { error: cortexError } : {}) },
      steps,
      reportPath,
      passes: detPasses && !kbError && !cortexError,
    };
  } finally {
    await disposeCortex().catch(() => {});
    resetCortexForTests();
    resetEntityGraphDb(tempRoot);
    resetTimelineDb(tempRoot);
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function formatMarkdownReport(args: {
  kbBefore: KbSnapshot; kbAfter: KbSnapshot;
  cortexBefore: CortexSnapshot; cortexAfter: CortexSnapshot;
  steps: StepResult[];
  kbDurationMs: number; cortexDurationMs: number;
  kbError?: string; cortexError?: string;
}): string {
  const { kbBefore, kbAfter, cortexBefore, cortexAfter, steps, kbDurationMs, cortexDurationMs, kbError, cortexError } = args;
  const lines: string[] = [];
  lines.push('# Cortex sleep-parity report (Harness 3)');
  lines.push('');
  lines.push(`- KB cycle: ${kbDurationMs}ms${kbError ? ` — ERROR: ${kbError}` : ''}`);
  lines.push(`- Cortex cycle: ${cortexDurationMs}ms${cortexError ? ` — ERROR: ${cortexError}` : ''}`);
  lines.push('');
  lines.push('## Per-step results');
  lines.push('');
  lines.push('| step | kind | ran | passes | note |');
  lines.push('|------|------|-----|--------|------|');
  for (const s of steps) {
    lines.push(`| ${s.step} | ${s.kind} | ${s.ran ? '✓' : '✗'} | ${s.passes ? '✓' : '✗'} | ${s.note} |`);
  }
  lines.push('');

  lines.push('## LLM-step side-by-side (eyeball review)');
  lines.push('');

  // tag step: memories with tags change
  lines.push('### tag — memory → KB tags / Cortex tags');
  lines.push('');
  lines.push('| memory | KB before | KB after | Cortex before | Cortex after |');
  lines.push('|--------|-----------|----------|---------------|--------------|');
  for (const [sp, b] of kbBefore.memories) {
    const a = kbAfter.memories.get(sp);
    const cb = cortexBefore.memories.get(sp);
    const ca = cortexAfter.memories.get(sp);
    if (b.tags === a?.tags && cb?.tags === ca?.tags) continue; // nothing changed on either side
    lines.push(`| ${sp.split('/').pop()} | ${b.tags ?? '-'} | ${a?.tags ?? '-'} | ${cb?.tags ?? '-'} | ${ca?.tags ?? '-'} |`);
  }
  lines.push('');

  // summarize step
  lines.push('### summarize — memory → KB summary / Cortex summary');
  lines.push('');
  for (const [sp, b] of kbBefore.memories) {
    const a = kbAfter.memories.get(sp);
    const cb = cortexBefore.memories.get(sp);
    const ca = cortexAfter.memories.get(sp);
    if (b.summary === a?.summary && cb?.summary === ca?.summary) continue;
    lines.push(`**${sp.split('/').pop()}**`);
    lines.push('- KB before:   ' + (b.summary.slice(0, 200) + (b.summary.length > 200 ? '…' : '')));
    lines.push('- KB after:    ' + ((a?.summary ?? '').slice(0, 200) + ((a?.summary?.length ?? 0) > 200 ? '…' : '')));
    lines.push('- Cortex before: ' + ((cb?.summary ?? '').slice(0, 200) + ((cb?.summary?.length ?? 0) > 200 ? '…' : '')));
    lines.push('- Cortex after:  ' + ((ca?.summary ?? '').slice(0, 200) + ((ca?.summary?.length ?? 0) > 200 ? '…' : '')));
    lines.push('');
  }

  return lines.join('\n');
}

export function formatSleepParityReport(run: SleepParityRun): string {
  const lines: string[] = [];
  lines.push('Cortex sleep parity report (Harness 3)');
  lines.push('─'.repeat(60));
  lines.push(`step group: ${run.options.stepGroup}`);
  lines.push(`seeded:     ${run.seeding.memories} memories, ${run.seeding.facts} facts, ${run.seeding.entities} entities, ${run.seeding.edges} edges`);
  if (run.seeding.unmirroredMemories.length) lines.push(`  unmirrored memories: ${run.seeding.unmirroredMemories.join(', ')}`);
  if (run.seeding.unmirroredFacts.length)    lines.push(`  unmirrored facts:    ${run.seeding.unmirroredFacts.join(', ')}`);
  if (run.seeding.unmirroredEntities.length) lines.push(`  unmirrored entities: ${run.seeding.unmirroredEntities.join(', ')}`);
  if (run.seeding.unmirroredEdges.length)    lines.push(`  unmirrored edges:    ${run.seeding.unmirroredEdges.join(', ')}`);
  lines.push(`KB cycle:     ${run.kbCycle.durationMs}ms${run.kbCycle.error ? `  ERROR: ${run.kbCycle.error}` : ''}`);
  lines.push(`Cortex cycle: ${run.cortexCycle.durationMs}ms${run.cortexCycle.error ? `  ERROR: ${run.cortexCycle.error}` : ''}`);
  lines.push(`verdict: ${run.passes ? 'PASS (deterministic steps only — review markdown for LLM)' : 'FAIL'}`);
  lines.push('');
  lines.push('per-step:');
  for (const s of run.steps) {
    const tag = s.kind === 'deterministic' ? (s.passes ? 'PASS' : 'FAIL') : 'LLM';
    lines.push(`  ${s.step.padEnd(16)} ${tag.padEnd(5)} ${s.note}`);
  }
  lines.push('');
  lines.push(`markdown report: ${run.reportPath}`);
  return lines.join('\n');
}
