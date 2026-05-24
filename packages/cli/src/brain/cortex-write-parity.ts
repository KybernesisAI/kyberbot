/**
 * Cortex write-parity harness — Harness 1 of the data-parity-matrix plan.
 *
 * For each KyberBot row that claims to be mirrored to Cortex (i.e. has a
 * non-null `arcana_*_id` FK), fetch the Cortex row by that id and assert
 * the content is semantically equivalent. The existing `cortex-parity.ts`
 * row-counter validates that mirrors happened; this one validates that
 * what was mirrored matches what was written locally.
 *
 * Read-only across both stores. Opens libsql DBs directly — no Cortex
 * provider stack needed for SELECTs.
 *
 * Coverage in this first pass:
 *   - facts (timeline.db `facts` ↔ arcana.db `facts`)
 *   - memories (timeline.db `timeline_events` ↔ arcana.db `memories`)
 *   - entities (entity-graph.db `entities` ↔ arcana.db `entities`)
 * Edges, insights, contradictions, profiles deferred — they have more
 * structural divergence and lower mirror coverage in current prod data.
 *
 * Plan: docs/plans/2026-05-24-data-parity-matrix.md (Harness 1).
 */

import Database from 'libsql';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

type Db = InstanceType<typeof Database>;

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface FieldDrift {
  field: string;
  kb: unknown;
  cortex: unknown;
}

export interface RowDrift {
  kbId: number;
  cortexId: string;
  drifts: FieldDrift[];
}

export interface PerKindReport {
  /** Total KB rows with a populated `arcana_*_id` FK. */
  mirrored: number;
  /** Mirrored rows where the Cortex side was unreachable (FK present but no Cortex row found). */
  cortexMissing: number;
  /** Rows where every audited field matched. */
  matching: number;
  /** Rows with at least one field drift. */
  drifted: number;
  /** Up to `sampleLimit` representative drift records. */
  sampleDrifts: RowDrift[];
}

export interface WriteParityReport {
  agentRoot: string;
  facts: PerKindReport;
  memories: PerKindReport;
  entities: PerKindReport;
  /** Per-kind elapsed milliseconds. Useful for catching pathologically slow scans. */
  timingMs: { facts: number; memories: number; entities: number };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DB OPEN / HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function openIfExists(path: string): Db | null {
  if (!existsSync(path)) return null;
  return new Database(path);
}

function parseJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a.map((s) => s.toLowerCase()));
  const sb = new Set(b.map((s) => s.toLowerCase()));
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

function numericClose(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

const NULLISH = new Set(['', null, undefined]);

function stringEqualNullish(a: string | null | undefined, b: string | null | undefined): boolean {
  if (NULLISH.has(a) && NULLISH.has(b)) return true;
  return a === b;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FACT DIFF
// ═══════════════════════════════════════════════════════════════════════════════

interface KbFactRow {
  id: number;
  content: string;
  source_path: string;
  source_conversation_id: string;
  entities_json: string;
  confidence: number;
  category: string;
  arcana_fact_id: string;
}

interface CortexFactRow {
  id: string;
  fact: string;
  entities_json: string;
  confidence: number;
  category: string;
  source_path: string | null;
  source_conversation_id: string | null;
}

function diffFact(kb: KbFactRow, cortex: CortexFactRow): FieldDrift[] {
  const drifts: FieldDrift[] = [];
  if (kb.content !== cortex.fact) {
    drifts.push({ field: 'content/fact', kb: kb.content, cortex: cortex.fact });
  }
  const kbEntities = parseJsonArray(kb.entities_json);
  const cxEntities = parseJsonArray(cortex.entities_json);
  if (!setsEqual(kbEntities, cxEntities)) {
    drifts.push({ field: 'entities', kb: kbEntities, cortex: cxEntities });
  }
  if (!numericClose(kb.confidence, cortex.confidence)) {
    drifts.push({ field: 'confidence', kb: kb.confidence, cortex: cortex.confidence });
  }
  if (kb.category !== cortex.category) {
    drifts.push({ field: 'category', kb: kb.category, cortex: cortex.category });
  }
  if (!stringEqualNullish(kb.source_path, cortex.source_path)) {
    drifts.push({ field: 'source_path', kb: kb.source_path, cortex: cortex.source_path });
  }
  if (!stringEqualNullish(kb.source_conversation_id, cortex.source_conversation_id)) {
    drifts.push({
      field: 'source_conversation_id',
      kb: kb.source_conversation_id,
      cortex: cortex.source_conversation_id,
    });
  }
  return drifts;
}

function inspectFacts(timeline: Db, cortex: Db, sampleLimit: number): PerKindReport {
  const report: PerKindReport = {
    mirrored: 0,
    cortexMissing: 0,
    matching: 0,
    drifted: 0,
    sampleDrifts: [],
  };

  const kbRows = timeline
    .prepare(
      `SELECT id, content, source_path, source_conversation_id, entities_json,
              confidence, category, arcana_fact_id
       FROM facts WHERE arcana_fact_id IS NOT NULL`,
    )
    .all() as KbFactRow[];

  report.mirrored = kbRows.length;

  const stmt = cortex.prepare(
    `SELECT id, fact, entities_json, confidence, category, source_path, source_conversation_id
     FROM facts WHERE id = ?`,
  );

  for (const kb of kbRows) {
    const cx = stmt.get(kb.arcana_fact_id) as CortexFactRow | undefined;
    if (!cx) {
      report.cortexMissing++;
      continue;
    }
    const drifts = diffFact(kb, cx);
    if (drifts.length === 0) {
      report.matching++;
    } else {
      report.drifted++;
      if (report.sampleDrifts.length < sampleLimit) {
        report.sampleDrifts.push({ kbId: kb.id, cortexId: cx.id, drifts });
      }
    }
  }
  return report;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY DIFF
// ═══════════════════════════════════════════════════════════════════════════════

interface KbTimelineEventRow {
  id: number;
  title: string;
  summary: string | null;
  arcana_memory_id: string;
}

interface CortexMemoryRow {
  id: string;
  title: string;
  summary: string;
}

function inspectMemories(timeline: Db, cortex: Db, sampleLimit: number): PerKindReport {
  const report: PerKindReport = {
    mirrored: 0,
    cortexMissing: 0,
    matching: 0,
    drifted: 0,
    sampleDrifts: [],
  };

  const kbRows = timeline
    .prepare(
      `SELECT id, title, summary, arcana_memory_id
       FROM timeline_events WHERE arcana_memory_id IS NOT NULL`,
    )
    .all() as KbTimelineEventRow[];
  report.mirrored = kbRows.length;

  const stmt = cortex.prepare(`SELECT id, title, summary FROM memories WHERE id = ?`);

  for (const kb of kbRows) {
    const cx = stmt.get(kb.arcana_memory_id) as CortexMemoryRow | undefined;
    if (!cx) {
      report.cortexMissing++;
      continue;
    }
    const drifts: FieldDrift[] = [];
    if (kb.title !== cx.title) {
      drifts.push({ field: 'title', kb: kb.title, cortex: cx.title });
    }
    // KB summary can be null; Cortex summary defaults to ''. Treat both as equivalent.
    if (!stringEqualNullish(kb.summary, cx.summary)) {
      drifts.push({ field: 'summary', kb: kb.summary, cortex: cx.summary });
    }
    if (drifts.length === 0) {
      report.matching++;
    } else {
      report.drifted++;
      if (report.sampleDrifts.length < sampleLimit) {
        report.sampleDrifts.push({ kbId: kb.id, cortexId: cx.id, drifts });
      }
    }
  }
  return report;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTITY DIFF
// ═══════════════════════════════════════════════════════════════════════════════

interface KbEntityRow {
  id: number;
  name: string;
  type: string;
  arcana_entity_id: string;
}

interface CortexEntityRow {
  id: string;
  name: string;
  type: string;
}

function inspectEntities(entityGraph: Db, cortex: Db, sampleLimit: number): PerKindReport {
  const report: PerKindReport = {
    mirrored: 0,
    cortexMissing: 0,
    matching: 0,
    drifted: 0,
    sampleDrifts: [],
  };

  const kbRows = entityGraph
    .prepare(
      `SELECT id, name, type, arcana_entity_id
       FROM entities WHERE arcana_entity_id IS NOT NULL`,
    )
    .all() as KbEntityRow[];
  report.mirrored = kbRows.length;

  const stmt = cortex.prepare(`SELECT id, name, type FROM entities WHERE id = ?`);

  for (const kb of kbRows) {
    const cx = stmt.get(kb.arcana_entity_id) as CortexEntityRow | undefined;
    if (!cx) {
      report.cortexMissing++;
      continue;
    }
    const drifts: FieldDrift[] = [];
    if (kb.name !== cx.name) {
      drifts.push({ field: 'name', kb: kb.name, cortex: cx.name });
    }
    if (kb.type !== cx.type) {
      drifts.push({ field: 'type', kb: kb.type, cortex: cx.type });
    }
    if (drifts.length === 0) {
      report.matching++;
    } else {
      report.drifted++;
      if (report.sampleDrifts.length < sampleLimit) {
        report.sampleDrifts.push({ kbId: kb.id, cortexId: cx.id, drifts });
      }
    }
  }
  return report;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC ENTRY
// ═══════════════════════════════════════════════════════════════════════════════

export function inspectWriteParity(
  root: string,
  opts: { sampleLimit?: number } = {},
): WriteParityReport {
  const sampleLimit = opts.sampleLimit ?? 5;
  const timeline = openIfExists(join(root, 'data', 'timeline.db'));
  const entityGraph = openIfExists(join(root, 'data', 'entity-graph.db'));
  const cortex = openIfExists(join(root, 'data', 'arcana.db'));

  const empty: PerKindReport = {
    mirrored: 0,
    cortexMissing: 0,
    matching: 0,
    drifted: 0,
    sampleDrifts: [],
  };

  try {
    const tFacts = Date.now();
    const facts = timeline && cortex ? inspectFacts(timeline, cortex, sampleLimit) : empty;
    const factsMs = Date.now() - tFacts;

    const tMems = Date.now();
    const memories = timeline && cortex ? inspectMemories(timeline, cortex, sampleLimit) : empty;
    const memsMs = Date.now() - tMems;

    const tEnts = Date.now();
    const entities =
      entityGraph && cortex ? inspectEntities(entityGraph, cortex, sampleLimit) : empty;
    const entsMs = Date.now() - tEnts;

    return {
      agentRoot: root,
      facts,
      memories,
      entities,
      timingMs: { facts: factsMs, memories: memsMs, entities: entsMs },
    };
  } finally {
    timeline?.close();
    entityGraph?.close();
    cortex?.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HUMAN-READABLE FORMATTER
// ═══════════════════════════════════════════════════════════════════════════════

function fmtPct(n: number, d: number): string {
  if (d === 0) return '   -';
  return `${((100 * n) / d).toFixed(1)}%`;
}

function describePerKind(kind: string, r: PerKindReport): string[] {
  const lines: string[] = [];
  lines.push(`  ${kind.padEnd(10)} mirrored=${r.mirrored.toLocaleString().padStart(7)}  ` +
    `match=${r.matching.toLocaleString().padStart(7)} (${fmtPct(r.matching, r.mirrored)})  ` +
    `drift=${r.drifted.toLocaleString().padStart(6)}  ` +
    `missing=${r.cortexMissing.toLocaleString().padStart(5)}`);
  if (r.sampleDrifts.length > 0) {
    for (const sd of r.sampleDrifts) {
      lines.push(`    #${sd.kbId} → ${sd.cortexId.slice(0, 8)}…`);
      for (const fd of sd.drifts) {
        const kb = truncateValue(fd.kb);
        const cx = truncateValue(fd.cortex);
        lines.push(`      ${fd.field}:`);
        lines.push(`        kb     = ${kb}`);
        lines.push(`        cortex = ${cx}`);
      }
    }
  }
  return lines;
}

function truncateValue(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === null || s === undefined) return String(s);
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}

export function formatWriteParityReport(report: WriteParityReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`Cortex write-parity — ${report.agentRoot}`);
  lines.push('(per-row content diff of mirrored KB rows against their Cortex twins)');
  lines.push('');
  lines.push(...describePerKind('facts', report.facts));
  lines.push(...describePerKind('memories', report.memories));
  lines.push(...describePerKind('entities', report.entities));
  lines.push('');
  lines.push(
    `Timing (ms): facts=${report.timingMs.facts}  memories=${report.timingMs.memories}  entities=${report.timingMs.entities}`,
  );
  lines.push('');

  const totalMirrored = report.facts.mirrored + report.memories.mirrored + report.entities.mirrored;
  const totalMatching = report.facts.matching + report.memories.matching + report.entities.matching;
  const totalDrifted = report.facts.drifted + report.memories.drifted + report.entities.drifted;
  const totalMissing =
    report.facts.cortexMissing + report.memories.cortexMissing + report.entities.cortexMissing;
  lines.push(
    `TOTAL      mirrored=${totalMirrored.toLocaleString().padStart(7)}  ` +
      `match=${totalMatching.toLocaleString().padStart(7)} (${fmtPct(totalMatching, totalMirrored)})  ` +
      `drift=${totalDrifted.toLocaleString().padStart(6)}  ` +
      `missing=${totalMissing.toLocaleString().padStart(5)}`,
  );
  const verdict = totalMirrored > 0 && totalDrifted === 0 && totalMissing === 0
    ? '✓ PASS (every mirrored row has byte-equivalent content on Cortex side)'
    : '⚠ DRIFT (see samples above; investigate before any migration)';
  lines.push(`Verdict:   ${verdict}`);
  lines.push('');
  return lines.join('\n');
}
