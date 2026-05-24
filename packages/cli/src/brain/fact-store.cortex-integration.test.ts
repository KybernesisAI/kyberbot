import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { StructuredStore } from '@kybernesis/cortex-contracts';
import {
  createFakeStructuredStore,
  createFakeVectorStore,
  createFakeEmbeddingProvider,
  createFakeLLMProvider,
} from '@kybernesis/cortex-testkit/fakes';

// Mock embeddings — fact-store still calls indexDocument inline. Stub to no-op
// so the test exercises only the SQLite + Arcana mirror path.
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
} = await import('./fact-store.js');
const { getTimelineDb, resetTimelineDb } = await import('./timeline.js');
const { initCortex, resetCortexForTests } = await import('./cortex-singleton.js');

let root: string;
let structured: StructuredStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-fact-arcana-'));
  await ensureFactsTable(root);

  structured = createFakeStructuredStore();
  await structured.connect();
  await initCortex({
    structured,
    vector: createFakeVectorStore(),
    embed: createFakeEmbeddingProvider(),
    llm: createFakeLLMProvider(),
  });
});

afterAll(async () => {
  resetTimelineDb(root);
  resetCortexForTests();
  await rm(root, { recursive: true, force: true });
});

// Same pre-existing-bug workaround as fact-store.test.ts — drop the broken
// facts_fts triggers before each test.
beforeEach(async () => {
  const db = await getTimelineDb(root);
  db.exec(`DROP TRIGGER IF EXISTS facts_fts_ai`);
  db.exec(`DROP TRIGGER IF EXISTS facts_fts_ad`);
  db.exec(`DROP TRIGGER IF EXISTS facts_fts_au`);
  db.exec(`DROP TABLE IF EXISTS facts_fts`);
});

describe('fact-store ↔ Arcana dual-write integration (ADR 004 — command.recordFact)', () => {
  it('mirrors a new fact into Arcana and stores the fact id locally', async () => {
    const id = await storeFact(root, {
      content: 'Alice prefers oat milk in her coffee',
      source_path: '/int/alice-oat',
      source_conversation_id: 'int-1',
      entities: ['Alice'],
      timestamp: '2026-05-18T10:00:00Z',
      confidence: 0.85,
      category: 'preference',
      source_type: 'chat',
    });
    expect(id).toBeGreaterThan(0);

    const db = await getTimelineDb(root);
    const row = db
      .prepare('SELECT arcana_fact_id FROM facts WHERE id = ?')
      .get(id) as { arcana_fact_id: string | null };

    expect(row.arcana_fact_id).not.toBeNull();
    expect(typeof row.arcana_fact_id).toBe('string');

    const facts = await structured.getFactsForEntity('Alice');
    expect(facts).toHaveLength(1);
    expect(facts[0].id).toBe(row.arcana_fact_id);
    expect(facts[0].fact).toBe('Alice prefers oat milk in her coffee');
    expect(facts[0].entity).toBe('Alice');
    expect(facts[0].sourceType).toBe('chat');
    expect(facts[0].confidence).toBe(0.85);
  });

  it('uses the first entity in entities[] as the Arcana Fact subject', async () => {
    const id = await storeFact(root, {
      content: 'Bob works at Acme',
      source_path: '/int/bob-acme',
      source_conversation_id: 'int-2',
      entities: ['Bob', 'Acme'],
      timestamp: '2026-05-18T10:05:00Z',
      confidence: 0.9,
      category: 'biographical',
      source_type: 'user-direct',
    });
    expect(id).toBeGreaterThan(0);

    const bobFacts = await structured.getFactsForEntity('Bob');
    expect(bobFacts).toHaveLength(1);
    expect(bobFacts[0].fact).toBe('Bob works at Acme');
    expect(bobFacts[0].sourceType).toBe('terminal');

    // Acme is NOT a separate Arcana Fact — only the first entity becomes the subject.
    const acmeFacts = await structured.getFactsForEntity('Acme');
    expect(acmeFacts).toHaveLength(0);
  });

  it('maps source_type values onto Arcana FactSourceType', async () => {
    const cases = [
      { kbSource: 'chat', arcanaSource: 'chat' as const, entity: 'SourceChat' },
      { kbSource: 'user-direct', arcanaSource: 'terminal' as const, entity: 'SourceUserDirect' },
      { kbSource: 'user-correction', arcanaSource: 'terminal' as const, entity: 'SourceUserCorrection' },
      { kbSource: 'ai-extraction', arcanaSource: 'ai-extraction' as const, entity: 'SourceAiExtraction' },
      { kbSource: 'heartbeat', arcanaSource: 'ai-extraction' as const, entity: 'SourceHeartbeat' },
    ];

    for (const { kbSource, arcanaSource, entity } of cases) {
      await storeFact(root, {
        content: `${entity} test fact`,
        source_path: `/int/source-map-${kbSource}`,
        source_conversation_id: `int-src-${kbSource}`,
        entities: [entity],
        timestamp: '2026-05-18T10:10:00Z',
        confidence: 0.7,
        category: 'general',
        source_type: kbSource,
      });

      const facts = await structured.getFactsForEntity(entity);
      expect(facts).toHaveLength(1);
      expect(facts[0].sourceType).toBe(arcanaSource);
    }
  });

  it('passes ARP scope fields through to Arcana scopes (snake_case)', async () => {
    const id = await storeFact(root, {
      content: 'Project Atlas ships next quarter',
      source_path: '/int/atlas-q3',
      source_conversation_id: 'int-4',
      entities: ['Atlas'],
      timestamp: '2026-05-18T10:15:00Z',
      confidence: 0.85,
      category: 'plan',
      source_type: 'user-direct',
      project_id: 'proj-atlas',
      classification: 'internal',
      connection_id: 'conn-abc',
      source_did: 'did:example:xyz',
    });
    expect(id).toBeGreaterThan(0);

    const facts = await structured.getFactsForEntity('Atlas');
    expect(facts).toHaveLength(1);
    expect(facts[0].scopes).toEqual({
      project_id: 'proj-atlas',
      classification: 'internal',
      connection_id: 'conn-abc',
      source_did: 'did:example:xyz',
    });
  });

  it('passes expires_at through to Arcana Fact', async () => {
    const id = await storeFact(root, {
      content: 'Carol is in Tokyo this week',
      source_path: '/int/carol-tokyo',
      source_conversation_id: 'int-temp',
      entities: ['Carol'],
      timestamp: '2026-05-18T10:20:00Z',
      confidence: 0.7,
      category: 'temporal',
      expires_at: '2026-05-25T00:00:00Z',
    });
    expect(id).toBeGreaterThan(0);

    const facts = await structured.getFactsForEntity('Carol');
    expect(facts[0].expiresAt).toBe('2026-05-25T00:00:00Z');
  });

  it('skips the Arcana mirror when entities[] is empty', async () => {
    const beforeCount = (await structured.listMemories()).length; // pre-state probe (memories untouched)
    const id = await storeFact(root, {
      content: 'an entity-less fact',
      source_path: '/int/no-entity',
      source_conversation_id: 'int-noent',
      entities: [],
      timestamp: '2026-05-18T10:25:00Z',
      confidence: 0.6,
      category: 'general',
      source_type: 'chat',
    });
    expect(id).toBeGreaterThan(0);

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT arcana_fact_id FROM facts WHERE id = ?').get(id) as { arcana_fact_id: string | null };
    expect(row.arcana_fact_id).toBeNull();

    // Memories not touched (fact-store doesn't mirror to memories anymore)
    const afterCount = (await structured.listMemories()).length;
    expect(afterCount).toBe(beforeCount);
  });

  it('re-write to same source_path keeps the existing arcana_fact_id (until correctFact lands)', async () => {
    const sourcePath = '/int/rewrite-stable-id';

    const firstId = await storeFact(root, {
      content: 'Dave likes tea',
      source_path: sourcePath,
      source_conversation_id: 'int-rw-1',
      entities: ['Dave'],
      timestamp: '2026-05-18T10:30:00Z',
      confidence: 0.7,
      category: 'preference',
      source_type: 'chat',
    });
    expect(firstId).toBeGreaterThan(0);

    const db = await getTimelineDb(root);
    const firstRow = db.prepare('SELECT arcana_fact_id FROM facts WHERE source_path = ?').get(sourcePath) as { arcana_fact_id: string };
    const firstFactId = firstRow.arcana_fact_id;
    expect(firstFactId).not.toBeNull();

    await storeFact(root, {
      content: 'Dave prefers coffee now',
      source_path: sourcePath,
      source_conversation_id: 'int-rw-2',
      entities: ['Dave'],
      timestamp: '2026-05-18T10:31:00Z',
      confidence: 0.8,
      category: 'preference',
      source_type: 'chat',
    });

    const secondRow = db.prepare('SELECT arcana_fact_id FROM facts WHERE source_path = ?').get(sourcePath) as { arcana_fact_id: string };
    expect(secondRow.arcana_fact_id).toBe(firstFactId);

    // The Arcana fact still has the original content — correctFact isn't
    // implemented yet, so re-writes don't propagate to Arcana.
    const facts = await structured.getFactsForEntity('Dave');
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toBe('Dave likes tea');
  });

  it('preserves local row contract — id is numeric and the fact lives in libsql even when Arcana mirror succeeds', async () => {
    const id = await storeFact(root, {
      content: 'local contract',
      source_path: '/int/local-contract',
      source_conversation_id: 'int-local',
      entities: ['LocalSubject'],
      timestamp: '2026-05-18T10:35:00Z',
      confidence: 0.7,
      category: 'general',
    });

    expect(typeof id).toBe('number');
    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT id, content FROM facts WHERE id = ?').get(id) as { id: number; content: string };
    expect(row.id).toBe(id);
    expect(row.content).toBe('local contract');
  });
});
