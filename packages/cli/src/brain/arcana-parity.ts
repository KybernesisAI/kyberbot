/**
 * Arcana parity inspector — side-by-side comparison of legacy KyberBot
 * stores against the Arcana mirror.
 *
 * Read-only. Uses the canonical parity signals already in the schema:
 *   - timeline_events.arcana_memory_id (NOT NULL when dual-write succeeded)
 *   - facts.arcana_fact_id            (NOT NULL when dual-write succeeded)
 *
 * Reports:
 *   1. Lifetime totals on each side and how many legacy rows claim to be
 *      mirrored. Drift = legacy mirrored > arcana total (orphaned IDs).
 *   2. Recent writes: most-recent legacy rows + their arcana mirror presence.
 */

import Database from 'libsql';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

type Db = InstanceType<typeof Database>;

export interface ParityTotals {
  /** Total rows on the legacy side. */
  legacy: number;
  /** Subset of legacy rows that claim to be mirrored to Arcana (FK column NOT NULL). */
  legacyMirrored: number;
  /** Total rows on the Arcana side. */
  arcana: number;
}

export interface ParityReport {
  agentRoot: string;
  memories: ParityTotals;
  facts: ParityTotals;
  entities: { legacy: number; arcana: number };
  edges: { legacy: number; arcana: number };
  insights: { legacy: number; arcana: number };
  profiles: { legacy: number; arcana: number };
  contradictions: { legacy: number; arcana: number };
  recentWrites: Array<{
    rowId: number;
    type: string;
    timestamp: string;
    sourcePath: string;
    arcanaMemoryId: string | null;
  }>;
}

interface DbHandles {
  entityGraph: Db | null;
  timeline: Db | null;
  arcana: Db | null;
}

function openIfExists(path: string): Db | null {
  if (!existsSync(path)) return null;
  // Existence is verified; only SELECTs are executed below.
  return new Database(path);
}

function safeCount(db: Db | null, sql: string): number {
  if (!db) return 0;
  try {
    const row = db.prepare(sql).get() as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

function openAllDbs(root: string): DbHandles {
  return {
    entityGraph: openIfExists(join(root, 'data', 'entity-graph.db')),
    timeline: openIfExists(join(root, 'data', 'timeline.db')),
    arcana: openIfExists(join(root, 'data', 'arcana.db')),
  };
}

function closeAllDbs(handles: DbHandles): void {
  handles.entityGraph?.close();
  handles.timeline?.close();
  handles.arcana?.close();
}

function getRecentWrites(handles: DbHandles, limit: number): ParityReport['recentWrites'] {
  if (!handles.timeline) return [];
  const rows = handles.timeline.prepare(`
    SELECT id, type, timestamp, source_path, arcana_memory_id
    FROM timeline_events
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit) as Array<{ id: number; type: string; timestamp: string; source_path: string; arcana_memory_id: string | null }>;
  return rows.map(r => ({
    rowId: r.id,
    type: r.type,
    timestamp: r.timestamp,
    sourcePath: r.source_path,
    arcanaMemoryId: r.arcana_memory_id,
  }));
}

export function inspectParity(root: string, opts: { detail?: number } = {}): ParityReport {
  const handles = openAllDbs(root);
  try {
    return {
      agentRoot: root,
      memories: {
        legacy: safeCount(handles.timeline, 'SELECT count(*) AS c FROM timeline_events'),
        legacyMirrored: safeCount(handles.timeline, 'SELECT count(*) AS c FROM timeline_events WHERE arcana_memory_id IS NOT NULL'),
        arcana: safeCount(handles.arcana, 'SELECT count(*) AS c FROM memories'),
      },
      facts: {
        legacy: safeCount(handles.timeline, 'SELECT count(*) AS c FROM facts'),
        legacyMirrored: safeCount(handles.timeline, 'SELECT count(*) AS c FROM facts WHERE arcana_fact_id IS NOT NULL'),
        arcana: safeCount(handles.arcana, 'SELECT count(*) AS c FROM facts'),
      },
      entities: {
        legacy: safeCount(handles.entityGraph, 'SELECT count(*) AS c FROM entities'),
        arcana: safeCount(handles.arcana, 'SELECT count(*) AS c FROM entities'),
      },
      edges: {
        legacy: safeCount(handles.entityGraph, 'SELECT count(*) AS c FROM entity_relations'),
        arcana: safeCount(handles.arcana, 'SELECT count(*) AS c FROM edges'),
      },
      insights: {
        legacy: safeCount(handles.entityGraph, 'SELECT count(*) AS c FROM entity_insights'),
        arcana: safeCount(handles.arcana, 'SELECT count(*) AS c FROM insights'),
      },
      profiles: {
        legacy: safeCount(handles.entityGraph, 'SELECT count(*) AS c FROM entity_profiles'),
        arcana: safeCount(handles.arcana, 'SELECT count(*) AS c FROM entity_profiles'),
      },
      contradictions: {
        legacy: safeCount(handles.entityGraph, 'SELECT count(*) AS c FROM contradictions'),
        arcana: safeCount(handles.arcana, 'SELECT count(*) AS c FROM contradictions'),
      },
      recentWrites: opts.detail ? getRecentWrites(handles, opts.detail) : [],
    };
  } finally {
    closeAllDbs(handles);
  }
}

function fmt(n: number): string {
  return n.toLocaleString().padStart(8);
}

function statusForMirrored(legacyMirrored: number, arcanaTotal: number): string {
  if (legacyMirrored === 0 && arcanaTotal === 0) return '   -';
  if (legacyMirrored === arcanaTotal) return '   ✓ match';
  const diff = legacyMirrored - arcanaTotal;
  if (diff > 0) return `   ⚠ ${diff} orphan FK on legacy (arcana.db wiped or write failed?)`;
  return `   ⚠ ${-diff} extra in arcana (not claimed by legacy FK)`;
}

function statusForSimple(legacy: number, arcana: number): string {
  if (legacy === 0 && arcana === 0) return '   -';
  if (legacy === arcana) return '   ✓ match';
  return `   ⚠ delta ${arcana - legacy}`;
}

export function formatParityReport(report: ParityReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`Arcana parity — ${report.agentRoot}`);
  lines.push('');
  lines.push('                  Legacy   Mirrored?    Arcana');
  lines.push(`  memories     ${fmt(report.memories.legacy)} ${fmt(report.memories.legacyMirrored)}  ${fmt(report.memories.arcana)}${statusForMirrored(report.memories.legacyMirrored, report.memories.arcana)}`);
  lines.push(`  facts        ${fmt(report.facts.legacy)} ${fmt(report.facts.legacyMirrored)}  ${fmt(report.facts.arcana)}${statusForMirrored(report.facts.legacyMirrored, report.facts.arcana)}`);
  lines.push('');
  lines.push('                  Legacy                Arcana');
  lines.push(`  entities     ${fmt(report.entities.legacy)}          ${fmt(report.entities.arcana)}${statusForSimple(report.entities.legacy, report.entities.arcana)}`);
  lines.push(`  edges        ${fmt(report.edges.legacy)}          ${fmt(report.edges.arcana)}${statusForSimple(report.edges.legacy, report.edges.arcana)}`);
  lines.push(`  insights     ${fmt(report.insights.legacy)}          ${fmt(report.insights.arcana)}${statusForSimple(report.insights.legacy, report.insights.arcana)}`);
  lines.push(`  profiles     ${fmt(report.profiles.legacy)}          ${fmt(report.profiles.arcana)}${statusForSimple(report.profiles.legacy, report.profiles.arcana)}`);
  lines.push(`  contradictions ${fmt(report.contradictions.legacy)}        ${fmt(report.contradictions.arcana)}${statusForSimple(report.contradictions.legacy, report.contradictions.arcana)}`);

  if (report.recentWrites.length > 0) {
    lines.push('');
    lines.push('Recent writes (most-recent first):');
    for (const w of report.recentWrites) {
      const hit = w.arcanaMemoryId ? `✓ → ${w.arcanaMemoryId.slice(0, 8)}…` : '✗ MISSING';
      const tail = w.sourcePath.slice(-40);
      lines.push(`  #${String(w.rowId).padEnd(6)} ${w.type.padEnd(13)} ${w.timestamp}  ${tail}  ${hit}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
