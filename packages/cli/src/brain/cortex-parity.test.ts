import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'libsql';
import { inspectParity, formatParityReport } from './cortex-parity.js';

interface TimelineRow { type?: string; mirrored?: boolean; ts?: string; sourcePath?: string }

function makeLegacyTimelineDb(path: string, opts: { events?: TimelineRow[]; facts?: { mirrored: boolean }[] }): void {
  const db = new Database(path);
  // Match the real production schema shape — timestamp + arcana_memory_id FK.
  db.prepare(`CREATE TABLE timeline_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    source_path TEXT NOT NULL,
    arcana_memory_id TEXT
  )`).run();
  db.prepare(`CREATE TABLE facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    arcana_fact_id TEXT
  )`).run();

  const insertEvent = db.prepare(`INSERT INTO timeline_events (type, timestamp, source_path, arcana_memory_id) VALUES (?, ?, ?, ?)`);
  for (const [i, e] of (opts.events ?? []).entries()) {
    insertEvent.run(
      e.type ?? 'conversation',
      e.ts ?? new Date(2026, 4, 20, 12, i).toISOString(),
      e.sourcePath ?? `channel://terminal/conv-${i}`,
      e.mirrored ? `arc-${i}` : null,
    );
  }
  const insertFact = db.prepare(`INSERT INTO facts (timestamp, arcana_fact_id) VALUES (?, ?)`);
  for (const [i, f] of (opts.facts ?? []).entries()) {
    insertFact.run(new Date(2026, 4, 20, 12, i).toISOString(), f.mirrored ? `arcfact-${i}` : null);
  }
  db.close();
}

function makeLegacyEntityGraphDb(path: string, opts: { entities: number }): void {
  const db = new Database(path);
  db.prepare(`CREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT, first_seen TEXT)`).run();
  db.prepare(`CREATE TABLE entity_relations (id INTEGER PRIMARY KEY)`).run();
  db.prepare(`CREATE TABLE entity_insights (id INTEGER PRIMARY KEY)`).run();
  db.prepare(`CREATE TABLE entity_profiles (id INTEGER PRIMARY KEY)`).run();
  db.prepare(`CREATE TABLE contradictions (id INTEGER PRIMARY KEY)`).run();
  const ts = new Date().toISOString();
  const stmt = db.prepare(`INSERT INTO entities (name, first_seen) VALUES (?, ?)`);
  for (let i = 0; i < opts.entities; i++) stmt.run(`Entity ${i}`, ts);
  db.close();
}

function makeArcanaDb(path: string, opts: { memories: number; entities: number; facts: number }): void {
  const db = new Database(path);
  db.prepare(`CREATE TABLE memories (id TEXT PRIMARY KEY)`).run();
  db.prepare(`CREATE TABLE entities (id TEXT PRIMARY KEY)`).run();
  db.prepare(`CREATE TABLE facts (id TEXT PRIMARY KEY)`).run();
  db.prepare(`CREATE TABLE edges (id TEXT PRIMARY KEY)`).run();
  db.prepare(`CREATE TABLE insights (id TEXT PRIMARY KEY)`).run();
  db.prepare(`CREATE TABLE entity_profiles (id TEXT PRIMARY KEY)`).run();
  db.prepare(`CREATE TABLE contradictions (id TEXT PRIMARY KEY)`).run();
  for (let i = 0; i < opts.memories; i++) db.prepare(`INSERT INTO memories VALUES (?)`).run(`m-${i}`);
  for (let i = 0; i < opts.entities; i++) db.prepare(`INSERT INTO entities VALUES (?)`).run(`e-${i}`);
  for (let i = 0; i < opts.facts; i++) db.prepare(`INSERT INTO facts VALUES (?)`).run(`f-${i}`);
  db.close();
}

describe('inspectParity', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kyberbot-parity-'));
    mkdirSync(join(root, 'data'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns zeros when no databases exist', () => {
    const report = inspectParity(root);
    expect(report.memories.legacy).toBe(0);
    expect(report.memories.legacyMirrored).toBe(0);
    expect(report.memories.arcana).toBe(0);
    expect(report.recentWrites).toEqual([]);
  });

  it('counts legacy total, legacy-mirrored (via arcana_memory_id FK), and arcana total', () => {
    makeLegacyTimelineDb(join(root, 'data', 'timeline.db'), {
      events: [
        { mirrored: true }, { mirrored: true }, { mirrored: true }, // 3 claim mirrored
        { mirrored: false }, { mirrored: false }, // 2 not mirrored
      ],
      facts: [
        { mirrored: true }, { mirrored: true }, // 2 mirrored
        { mirrored: false }, // 1 not
      ],
    });
    makeArcanaDb(join(root, 'data', 'arcana.db'), { memories: 3, entities: 0, facts: 2 });

    const report = inspectParity(root);

    expect(report.memories.legacy).toBe(5);
    expect(report.memories.legacyMirrored).toBe(3);
    expect(report.memories.arcana).toBe(3);
    expect(report.facts.legacy).toBe(3);
    expect(report.facts.legacyMirrored).toBe(2);
    expect(report.facts.arcana).toBe(2);
  });

  it('detects orphan FKs — legacy claims mirrored but arcana.db is smaller', () => {
    // Real-world scenario: arcana.db was wiped between adoption attempts,
    // but legacy still has arcana_memory_id values from the prior run.
    makeLegacyTimelineDb(join(root, 'data', 'timeline.db'), {
      events: Array(50).fill(null).map(() => ({ mirrored: true })),
    });
    makeArcanaDb(join(root, 'data', 'arcana.db'), { memories: 5, entities: 0, facts: 0 });

    const report = inspectParity(root);

    expect(report.memories.legacyMirrored).toBe(50);
    expect(report.memories.arcana).toBe(5);
    const out = formatParityReport(report);
    expect(out).toMatch(/orphan FK/);
  });

  it('counts entities and edges across both sides', () => {
    makeLegacyEntityGraphDb(join(root, 'data', 'entity-graph.db'), { entities: 25 });
    makeArcanaDb(join(root, 'data', 'arcana.db'), { memories: 0, entities: 3, facts: 0 });
    const report = inspectParity(root);
    expect(report.entities.legacy).toBe(25);
    expect(report.entities.arcana).toBe(3);
  });

  it('--detail returns recent writes most-recent-first with arcana FK presence', () => {
    makeLegacyTimelineDb(join(root, 'data', 'timeline.db'), {
      events: [
        { mirrored: false, ts: '2026-05-20T10:00:00Z' }, // oldest
        { mirrored: true,  ts: '2026-05-20T11:00:00Z' },
        { mirrored: true,  ts: '2026-05-20T12:00:00Z' }, // newest
      ],
    });

    const report = inspectParity(root, { detail: 5 });

    expect(report.recentWrites.length).toBe(3);
    expect(report.recentWrites[0].timestamp).toBe('2026-05-20T12:00:00Z'); // newest first
    expect(report.recentWrites[0].arcanaMemoryId).not.toBeNull();
    expect(report.recentWrites[2].arcanaMemoryId).toBeNull(); // oldest, unmirrored
  });

  it('formatParityReport produces a human-readable summary including the headers', () => {
    makeArcanaDb(join(root, 'data', 'arcana.db'), { memories: 1, entities: 1, facts: 1 });
    const report = inspectParity(root);
    const out = formatParityReport(report);
    expect(out).toContain('Arcana parity');
    expect(out).toContain('Mirrored?');
    expect(out).toContain('memories');
    expect(out).toContain('facts');
    expect(out).toContain('entities');
  });
});
