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

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Stub embeddings — fact-store still calls indexDocument inline.
vi.mock('./embeddings.js', () => ({
  indexDocument: vi.fn(async () => 0),
  isChromaAvailable: vi.fn(() => false),
}));

// Mock the Haiku call. Real fact-store + real Arcana path stay intact below.
const completeMock = vi.fn<(prompt: string, opts?: unknown) => Promise<string>>();
vi.mock('../claude.js', () => ({
  getClaudeClient: () => ({ complete: completeMock }),
}));

const { extractFactsRealtime } = await import('./fact-extractor.js');
const { ensureFactsTable } = await import('./fact-store.js');
const { getTimelineDb, resetTimelineDb } = await import('./timeline.js');
const { initCortex, resetCortexForTests } = await import('./cortex-singleton.js');

let root: string;
let structured: StructuredStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-fact-extract-arcana-'));
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

beforeEach(async () => {
  completeMock.mockReset();
  // Same pre-existing-bug workaround as fact-store.test.ts.
  const db = await getTimelineDb(root);
  db.exec(`DROP TRIGGER IF EXISTS facts_fts_ai`);
  db.exec(`DROP TRIGGER IF EXISTS facts_fts_ad`);
  db.exec(`DROP TRIGGER IF EXISTS facts_fts_au`);
  db.exec(`DROP TABLE IF EXISTS facts_fts`);
});

const longText =
  'During the planning meeting Alice committed to the new milestone, and we agreed to ' +
  'revisit the architecture decisions next week with the wider team.';

describe('fact-extractor → fact-store → Arcana command.recordFact (module #5 integration)', () => {
  it('extracted facts land in Arcana as Facts via storeFact', async () => {
    completeMock.mockResolvedValueOnce(JSON.stringify([
      { content: 'Alice committed to the new milestone', category: 'plan', confidence: 0.7, entities: ['Alice'] },
    ]));

    const created = await extractFactsRealtime(
      root, longText, ['Alice'],
      '/integration/extract-1', 'conv-int-1', '2026-05-18T10:00:00Z', 'chat',
    );

    expect(created).toBe(1);

    const arcanaFacts = await structured.getFactsForEntity('Alice');
    expect(arcanaFacts).toHaveLength(1);
    expect(arcanaFacts[0].fact).toBe('Alice committed to the new milestone');
    expect(arcanaFacts[0].entity).toBe('Alice');
    expect(arcanaFacts[0].sourceType).toBe('ai-extraction');
    expect(arcanaFacts[0].confidence).toBe(0.60);  // capped at ai-extraction ceiling
  });

  it('first entity in each extracted fact becomes its Arcana subject', async () => {
    completeMock.mockResolvedValueOnce(JSON.stringify([
      { content: 'Bob hired Carol to lead the new team', category: 'event', confidence: 0.6, entities: ['Bob', 'Carol'] },
    ]));

    await extractFactsRealtime(
      root, longText, ['Bob', 'Carol'],
      '/integration/extract-2', 'conv-int-2', '2026-05-18T10:05:00Z', 'chat',
    );

    const bobFacts = await structured.getFactsForEntity('Bob');
    expect(bobFacts).toHaveLength(1);
    expect(bobFacts[0].fact).toBe('Bob hired Carol to lead the new team');

    // Carol is mentioned but not the Arcana subject for this fact.
    const carolFacts = await structured.getFactsForEntity('Carol');
    expect(carolFacts).toHaveLength(0);
  });

  it('ARP metadata flows through to Arcana scopes', async () => {
    completeMock.mockResolvedValueOnce(JSON.stringify([
      { content: 'Project Atlas ships in September', category: 'plan', confidence: 0.7, entities: ['Atlas'] },
    ]));

    await extractFactsRealtime(
      root, longText, ['Atlas'],
      '/integration/extract-arp', 'conv-int-arp', '2026-05-18T10:10:00Z', 'chat',
      {
        project_id: 'proj-atlas',
        classification: 'internal',
        connection_id: 'conn-1',
      },
    );

    const facts = await structured.getFactsForEntity('Atlas');
    expect(facts).toHaveLength(1);
    expect(facts[0].scopes).toEqual({
      project_id: 'proj-atlas',
      classification: 'internal',
      connection_id: 'conn-1',
    });
  });
});
