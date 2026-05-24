import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { addToTimeline, getEventByPath, getTimelineDb, resetTimelineDb } =
  await import('./timeline.js');
const { initCortex, resetCortexForTests } = await import('./cortex-singleton.js');

let root: string;
let structured: StructuredStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-timeline-arcana-'));

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

describe('timeline ↔ Arcana dual-write integration', () => {
  it('mirrors a new timeline event into Arcana and stores the memory id', async () => {
    const id = await addToTimeline(root, {
      type: 'conversation',
      timestamp: '2026-05-18T10:00:00Z',
      title: 'Integration test conversation',
      summary: 'Verifying dual-write to Arcana fake store',
      source_path: '/integration/conv-1',
      entities: ['Alice', 'Bob'],
      topics: ['arcana', 'integration'],
    });
    expect(id).toBeGreaterThan(0);

    const db = await getTimelineDb(root);
    const row = db
      .prepare('SELECT arcana_memory_id FROM timeline_events WHERE source_path = ?')
      .get('/integration/conv-1') as { arcana_memory_id: string | null };

    expect(row.arcana_memory_id).not.toBeNull();
    expect(typeof row.arcana_memory_id).toBe('string');
    expect(row.arcana_memory_id!.length).toBeGreaterThan(0);

    const memory = await structured.getMemory(row.arcana_memory_id!);
    expect(memory).not.toBeNull();
    expect(memory!.title).toBe('Integration test conversation');
    expect(memory!.summary).toBe('Verifying dual-write to Arcana fake store');
    expect(memory!.content).toBe('Verifying dual-write to Arcana fake store');
    expect(memory!.source).toBe('chat');
  });

  it('folds type, entities, and topics into Arcana tags', async () => {
    await addToTimeline(root, {
      type: 'note',
      timestamp: '2026-05-18T10:05:00Z',
      title: 'Tag folding test',
      summary: 'Should produce type/entity/topic tags',
      source_path: '/integration/tags-1',
      entities: ['Carol'],
      topics: ['k8s'],
      tags: ['custom-tag'],
    });

    const db = await getTimelineDb(root);
    const row = db
      .prepare('SELECT arcana_memory_id FROM timeline_events WHERE source_path = ?')
      .get('/integration/tags-1') as { arcana_memory_id: string };

    const memory = await structured.getMemory(row.arcana_memory_id);
    expect(memory!.tags).toEqual(
      expect.arrayContaining(['type:note', 'entity:Carol', 'topic:k8s', 'custom-tag']),
    );
    expect(memory!.source).toBe('cli');
  });

  it('passes ARP scope fields through to Arcana scopes (snake_case)', async () => {
    await addToTimeline(root, {
      type: 'idea',
      timestamp: '2026-05-18T10:10:00Z',
      title: 'Scoped event',
      summary: 'With ARP fields',
      source_path: '/integration/scoped-1',
      entities: [],
      topics: [],
      project_id: 'proj-abc',
      classification: 'internal',
      connection_id: 'conn-xyz',
      source_did: 'did:example:123',
    });

    const db = await getTimelineDb(root);
    const row = db
      .prepare('SELECT arcana_memory_id FROM timeline_events WHERE source_path = ?')
      .get('/integration/scoped-1') as { arcana_memory_id: string };

    const memory = await structured.getMemory(row.arcana_memory_id);
    expect(memory!.scopes).toEqual({
      project_id: 'proj-abc',
      classification: 'internal',
      connection_id: 'conn-xyz',
      source_did: 'did:example:123',
    });
  });

  it('falls back to title when summary is empty', async () => {
    await addToTimeline(root, {
      type: 'note',
      timestamp: '2026-05-18T10:15:00Z',
      title: 'Title-only event',
      summary: '',
      source_path: '/integration/title-only',
      entities: [],
      topics: [],
    });

    const db = await getTimelineDb(root);
    const row = db
      .prepare('SELECT arcana_memory_id FROM timeline_events WHERE source_path = ?')
      .get('/integration/title-only') as { arcana_memory_id: string };

    const memory = await structured.getMemory(row.arcana_memory_id);
    expect(memory!.content).toBe('Title-only event');
  });

  it('on re-write to the same source_path, updates the existing Arcana memory in place (no orphan)', async () => {
    const sourcePath = '/integration/upsert-no-orphan';

    await addToTimeline(root, {
      type: 'note',
      timestamp: '2026-05-18T10:30:00Z',
      title: 'Original title',
      summary: 'Original summary',
      source_path: sourcePath,
      entities: ['Orig'],
      topics: ['original'],
    });

    const db = await getTimelineDb(root);
    const firstRow = db
      .prepare('SELECT arcana_memory_id FROM timeline_events WHERE source_path = ?')
      .get(sourcePath) as { arcana_memory_id: string };
    const firstMemoryId = firstRow.arcana_memory_id;
    expect(firstMemoryId).not.toBeNull();

    await addToTimeline(root, {
      type: 'note',
      timestamp: '2026-05-18T10:31:00Z',
      title: 'Updated title',
      summary: 'Updated summary',
      source_path: sourcePath,
      entities: ['UpdatedEntity'],
      topics: ['updated'],
    });

    const secondRow = db
      .prepare('SELECT arcana_memory_id FROM timeline_events WHERE source_path = ?')
      .get(sourcePath) as { arcana_memory_id: string };
    expect(secondRow.arcana_memory_id).toBe(firstMemoryId);

    const memory = await structured.getMemory(firstMemoryId);
    expect(memory).not.toBeNull();
    expect(memory!.title).toBe('Updated title');
    expect(memory!.summary).toBe('Updated summary');
    expect(memory!.tags).toEqual(
      expect.arrayContaining(['type:note', 'entity:UpdatedEntity', 'topic:updated']),
    );
    expect(memory!.tags).not.toEqual(expect.arrayContaining(['entity:Orig']));
  });

  it('preserves local row contract (id is numeric, getEventByPath works)', async () => {
    const id = await addToTimeline(root, {
      type: 'transcript',
      timestamp: '2026-05-18T10:20:00Z',
      title: 'Local contract',
      summary: 'Arcana mirror should not break local API',
      source_path: '/integration/local-contract',
      entities: [],
      topics: [],
    });

    expect(typeof id).toBe('number');
    const event = await getEventByPath(root, '/integration/local-contract');
    expect(event).not.toBeNull();
    expect(event!.id).toBe(id);
    expect(event!.title).toBe('Local contract');
  });
});
