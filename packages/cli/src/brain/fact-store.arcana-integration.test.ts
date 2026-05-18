import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { StructuredStore } from '@kybernesisai/arcana-contracts';
import {
  createFakeStructuredStore,
  createFakeVectorStore,
  createFakeEmbeddingProvider,
  createFakeLLMProvider,
} from '@kybernesisai/arcana-testkit/fakes';

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
const { initArcana, resetArcanaForTests } = await import('./arcana-singleton.js');

let root: string;
let structured: StructuredStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-fact-arcana-'));
  await ensureFactsTable(root);

  structured = createFakeStructuredStore();
  await structured.connect();
  initArcana({
    structured,
    vector: createFakeVectorStore(),
    embed: createFakeEmbeddingProvider(),
    llm: createFakeLLMProvider(),
  });
});

afterAll(async () => {
  resetTimelineDb(root);
  resetArcanaForTests();
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

describe('fact-store ↔ Arcana dual-write integration', () => {
  it('mirrors a new fact into Arcana and stores the memory id locally', async () => {
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
      .prepare('SELECT arcana_memory_id FROM facts WHERE id = ?')
      .get(id) as { arcana_memory_id: string | null };

    expect(row.arcana_memory_id).not.toBeNull();
    expect(typeof row.arcana_memory_id).toBe('string');

    const memory = await structured.getMemory(row.arcana_memory_id!);
    expect(memory).not.toBeNull();
    expect(memory!.content).toBe('Alice prefers oat milk in her coffee');
    expect(memory!.source).toBe('chat');
  });

  it('maps non-chat source_type values to "cli" and preserves the original via tag', async () => {
    const id = await storeFact(root, {
      content: 'Bob mentioned the deadline in standup',
      source_path: '/int/bob-deadline',
      source_conversation_id: 'int-2',
      entities: ['Bob'],
      timestamp: '2026-05-18T10:05:00Z',
      confidence: 0.7,
      category: 'event',
      source_type: 'ai-extraction',
    });

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT arcana_memory_id FROM facts WHERE id = ?').get(id) as { arcana_memory_id: string };
    const memory = await structured.getMemory(row.arcana_memory_id);

    expect(memory!.source).toBe('cli');
    expect(memory!.tags).toContain('source-type:ai-extraction');
  });

  it('folds category and entities into Arcana tags', async () => {
    const id = await storeFact(root, {
      content: 'Carol joined Acme in March',
      source_path: '/int/carol-acme',
      source_conversation_id: 'int-3',
      entities: ['Carol', 'Acme'],
      timestamp: '2026-05-18T10:10:00Z',
      confidence: 0.8,
      category: 'biographical',
      source_type: 'chat',
      tags: ['custom-tag'],
    });

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT arcana_memory_id FROM facts WHERE id = ?').get(id) as { arcana_memory_id: string };
    const memory = await structured.getMemory(row.arcana_memory_id);

    expect(memory!.tags).toEqual(
      expect.arrayContaining([
        'fact:category:biographical',
        'source-type:chat',
        'entity:Carol',
        'entity:Acme',
        'custom-tag',
      ]),
    );
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

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT arcana_memory_id FROM facts WHERE id = ?').get(id) as { arcana_memory_id: string };
    const memory = await structured.getMemory(row.arcana_memory_id);

    expect(memory!.scopes).toEqual({
      project_id: 'proj-atlas',
      classification: 'internal',
      connection_id: 'conn-abc',
      source_did: 'did:example:xyz',
    });
  });

  it('preserves local row contract — id is numeric and the fact lives in libsql even when Arcana mirror succeeds', async () => {
    const id = await storeFact(root, {
      content: 'local contract',
      source_path: '/int/local-contract',
      source_conversation_id: 'int-5',
      entities: ['Local'],
      timestamp: '2026-05-18T10:20:00Z',
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
