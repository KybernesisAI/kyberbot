/**
 * Module #11 integration test — covers the two write paths sleep/observe.ts
 * fires that aren't already exercised by modules #1/#2/#4 wrappers:
 *
 *   1. markFactSuperseded (fact-store.ts) → command.markFactSuperseded
 *   2. createContradiction (entity-graph.ts) → command.storeContradiction
 *
 * Both are best-effort mirrors that look up the local row's arcana_fact_id
 * and skip when either side hasn't been mirrored.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { StructuredStore } from '@kybernesis/arcana-contracts';
import {
  createFakeStructuredStore,
  createFakeVectorStore,
  createFakeEmbeddingProvider,
  createFakeLLMProvider,
} from '@kybernesis/arcana-testkit/fakes';

vi.mock('./embeddings.js', () => ({
  indexDocument: vi.fn(async () => 0),
  isChromaAvailable: vi.fn(() => false),
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const {
  ensureFactsTable,
  storeFact,
  markFactSuperseded,
} = await import('./fact-store.js');
const {
  createContradiction,
  findOrCreateEntity,
  resetEntityGraphDb,
} = await import('./entity-graph.js');
const { getTimelineDb, resetTimelineDb } = await import('./timeline.js');
const { initArcana, resetArcanaForTests } = await import('./arcana-singleton.js');

let root: string;
let structured: StructuredStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-supersede-contradiction-'));
  await ensureFactsTable(root);

  structured = createFakeStructuredStore();
  await structured.connect();
  await initArcana({
    structured,
    vector: createFakeVectorStore(),
    embed: createFakeEmbeddingProvider(),
    llm: createFakeLLMProvider(),
  });
});

afterAll(async () => {
  resetTimelineDb(root);
  resetEntityGraphDb(root);
  resetArcanaForTests();
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  // Same FTS trigger workaround as the fact-store tests.
  const db = await getTimelineDb(root);
  db.exec(`DROP TRIGGER IF EXISTS facts_fts_ai`);
  db.exec(`DROP TRIGGER IF EXISTS facts_fts_ad`);
  db.exec(`DROP TRIGGER IF EXISTS facts_fts_au`);
  db.exec(`DROP TABLE IF EXISTS facts_fts`);
});

describe('markFactSuperseded → Arcana command.markFactSuperseded', () => {
  it('mirrors the supersede when both facts have arcana_fact_id', async () => {
    const oldId = await storeFact(root, {
      content: 'Bob works at OldCo',
      source_path: '/sup/old',
      source_conversation_id: 'conv-sup-1',
      entities: ['Bob'],
      timestamp: '2026-05-18T10:00:00Z',
      confidence: 0.7,
      category: 'biographical',
      source_type: 'chat',
    });
    const newId = await storeFact(root, {
      content: 'Bob works at NewCo',
      source_path: '/sup/new',
      source_conversation_id: 'conv-sup-2',
      entities: ['Bob'],
      timestamp: '2026-05-18T10:05:00Z',
      confidence: 0.9,
      category: 'biographical',
      source_type: 'chat',
    });

    const db = await getTimelineDb(root);
    const oldArcanaId = (db.prepare('SELECT arcana_fact_id FROM facts WHERE id = ?').get(oldId) as { arcana_fact_id: string }).arcana_fact_id;
    const newArcanaId = (db.prepare('SELECT arcana_fact_id FROM facts WHERE id = ?').get(newId) as { arcana_fact_id: string }).arcana_fact_id;
    expect(oldArcanaId).toBeTruthy();
    expect(newArcanaId).toBeTruthy();

    await markFactSuperseded(root, oldId, newId);

    // Verify local update happened (existing behavior preserved)
    const localRow = db.prepare('SELECT is_latest, superseded_by FROM facts WHERE id = ?').get(oldId) as { is_latest: number; superseded_by: number };
    expect(localRow.is_latest).toBe(0);
    expect(localRow.superseded_by).toBe(newId);

    // Verify Arcana mirror: the old fact's mirror is now isLatest=false, supersededBy=newArcanaId
    const arcanaFacts = await structured.getFactsForEntity('Bob');
    const mirroredOld = arcanaFacts.find(f => f.id === oldArcanaId);
    expect(mirroredOld).toBeDefined();
    expect(mirroredOld!.isLatest).toBe(false);
    expect(mirroredOld!.supersededBy).toBe(newArcanaId);
  });

  it('skips Arcana mirror cleanly when the old fact has no arcana_fact_id', async () => {
    // Insert an "ancient" fact directly — bypassing the mirror so arcana_fact_id is NULL.
    const db = await getTimelineDb(root);
    const ancient = db.prepare(`
      INSERT INTO facts (content, source_path, source_conversation_id, entities_json, timestamp, confidence, category, source_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('Ancient unmirrored fact', '/sup/ancient', 'conv-anc', '["Ghost"]', '2026-05-18T11:00:00Z', 0.6, 'biographical', 'chat');
    const oldId = ancient.lastInsertRowid as number;

    const newId = await storeFact(root, {
      content: 'Ghost fact replacement',
      source_path: '/sup/replacement',
      source_conversation_id: 'conv-rep',
      entities: ['Ghost'],
      timestamp: '2026-05-18T11:05:00Z',
      confidence: 0.9,
      category: 'biographical',
      source_type: 'chat',
    });

    // No throw — local update still proceeds.
    await expect(markFactSuperseded(root, oldId, newId)).resolves.not.toThrow();
    const localRow = db.prepare('SELECT is_latest, superseded_by FROM facts WHERE id = ?').get(oldId) as { is_latest: number; superseded_by: number };
    expect(localRow.is_latest).toBe(0);
    expect(localRow.superseded_by).toBe(newId);
  });
});

describe('createContradiction → Arcana command.storeContradiction', () => {
  it('mirrors the contradiction with rationale when both facts have arcana_fact_id', async () => {
    const factAId = await storeFact(root, {
      content: 'Alice lives in NYC',
      source_path: '/con/a',
      source_conversation_id: 'conv-con-1',
      entities: ['Alice'],
      timestamp: '2026-05-18T12:00:00Z',
      confidence: 0.7,
      category: 'biographical',
      source_type: 'chat',
    });
    const factBId = await storeFact(root, {
      content: 'Alice lives in SF',
      source_path: '/con/b',
      source_conversation_id: 'conv-con-2',
      entities: ['Alice'],
      timestamp: '2026-05-18T12:05:00Z',
      confidence: 0.75,
      category: 'biographical',
      source_type: 'chat',
    });

    const db = await getTimelineDb(root);
    const aArcanaId = (db.prepare('SELECT arcana_fact_id FROM facts WHERE id = ?').get(factAId) as { arcana_fact_id: string }).arcana_fact_id;
    const bArcanaId = (db.prepare('SELECT arcana_fact_id FROM facts WHERE id = ?').get(factBId) as { arcana_fact_id: string }).arcana_fact_id;

    const alice = await findOrCreateEntity(root, 'AliceConflict', 'person', '2026-05-18T12:00:00Z');
    const rationale = 'Same person cannot live in two cities simultaneously per the conversation context';

    const contradictionId = await createContradiction(
      root, alice.id, factAId, factBId,
      'Alice lives in NYC', 'Alice lives in SF', rationale,
    );
    expect(contradictionId).toBeGreaterThan(0);

    // Arcana mirror — both fact ids carried over, rationale present, status=pending by default
    const contradictions = await structured.listContradictions();
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0].factAId).toBe(aArcanaId);
    expect(contradictions[0].factBId).toBe(bArcanaId);
    expect(contradictions[0].rationale).toBe(rationale);
    expect(contradictions[0].status).toBe('pending');
  });

  it('skips Arcana mirror when one fact has no arcana_fact_id', async () => {
    // Unmirrored fact (direct insert)
    const db = await getTimelineDb(root);
    const noMirror = db.prepare(`
      INSERT INTO facts (content, source_path, source_conversation_id, entities_json, timestamp, confidence, category, source_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('No-mirror fact', '/con/no-mirror', 'conv-nomir', '["NoOne"]', '2026-05-18T13:00:00Z', 0.6, 'biographical', 'chat');
    const factAId = noMirror.lastInsertRowid as number;

    const factBId = await storeFact(root, {
      content: 'NoOne lives somewhere',
      source_path: '/con/mirrored',
      source_conversation_id: 'conv-mir',
      entities: ['NoOne'],
      timestamp: '2026-05-18T13:05:00Z',
      confidence: 0.7,
      category: 'biographical',
      source_type: 'chat',
    });

    const noOne = await findOrCreateEntity(root, 'NoOneConflict', 'person', '2026-05-18T13:00:00Z');
    const before = (await structured.listContradictions()).length;

    await createContradiction(
      root, noOne.id, factAId, factBId,
      'No-mirror fact', 'NoOne lives somewhere', 'rationale',
    );

    // No new Arcana contradiction should have been recorded.
    const after = (await structured.listContradictions()).length;
    expect(after).toBe(before);
  });
});
