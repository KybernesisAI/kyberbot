import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const {
  findOrCreateEntity,
  linkEntities,
  linkEntitiesWithType,
  deleteEntity,
  getEntityGraphDb,
  resetEntityGraphDb,
} = await import('./entity-graph.js');
const { initArcana, resetArcanaForTests } = await import('./arcana-singleton.js');

let root: string;
let structured: StructuredStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-entity-arcana-'));

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
  resetEntityGraphDb(root);
  resetArcanaForTests();
  await rm(root, { recursive: true, force: true });
});

describe('entity-graph ↔ Arcana dual-write integration', () => {
  it('mirrors a new entity into Arcana with stable arcana_entity_id', async () => {
    const e = await findOrCreateEntity(root, 'Alice', 'person', '2026-05-18T10:00:00Z');
    expect(e.arcana_entity_id).toBeDefined();
    expect(e.arcana_entity_id!.length).toBeGreaterThan(0);

    const mirrored = await structured.getEntity(e.arcana_entity_id!);
    expect(mirrored).not.toBeNull();
    expect(mirrored!.name).toBe('Alice');
    expect(mirrored!.type).toBe('person');
    expect(mirrored!.mentionCount).toBe(1);
  });

  it('updates mentionCount in Arcana when an existing entity is re-found', async () => {
    const first = await findOrCreateEntity(root, 'Bob', 'person', '2026-05-18T10:05:00Z');
    const arcanaId = first.arcana_entity_id!;

    await findOrCreateEntity(root, 'Bob', 'person', '2026-05-18T10:06:00Z');
    await findOrCreateEntity(root, 'Bob', 'person', '2026-05-18T10:07:00Z');

    const mirrored = await structured.getEntity(arcanaId);
    expect(mirrored).not.toBeNull();
    expect(mirrored!.mentionCount).toBe(3);
  });

  it('treats different entity types as separate Arcana entities', async () => {
    const person = await findOrCreateEntity(root, 'Acme', 'person', '2026-05-18T10:10:00Z');
    const company = await findOrCreateEntity(root, 'Acme', 'company', '2026-05-18T10:11:00Z');

    expect(person.arcana_entity_id).not.toBe(company.arcana_entity_id);

    const mp = await structured.getEntity(person.arcana_entity_id!);
    const mc = await structured.getEntity(company.arcana_entity_id!);
    expect(mp!.type).toBe('person');
    expect(mc!.type).toBe('company');
  });

  it('mirrors a new edge via linkNodes on first link only', async () => {
    const a = await findOrCreateEntity(root, 'EdgeA', 'person', '2026-05-18T10:15:00Z');
    const b = await findOrCreateEntity(root, 'EdgeB', 'person', '2026-05-18T10:15:00Z');

    await linkEntities(root, a.id, b.id, 'co-occurred');

    const db = await getEntityGraphDb(root);
    const [id1, id2] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    const firstRow = db
      .prepare('SELECT arcana_edge_id, strength FROM entity_relations WHERE source_id = ? AND target_id = ?')
      .get(id1, id2) as { arcana_edge_id: string | null; strength: number };

    expect(firstRow.arcana_edge_id).not.toBeNull();
    expect(firstRow.strength).toBe(1);
    const firstEdgeId = firstRow.arcana_edge_id;

    // Re-link — strength should bump locally; arcana_edge_id stays the same (no re-mirror)
    await linkEntities(root, a.id, b.id, 'co-occurred');
    const secondRow = db
      .prepare('SELECT arcana_edge_id, strength FROM entity_relations WHERE source_id = ? AND target_id = ?')
      .get(id1, id2) as { arcana_edge_id: string | null; strength: number };

    expect(secondRow.strength).toBe(2);
    expect(secondRow.arcana_edge_id).toBe(firstEdgeId);
  });

  it('passes typed relations through to linkNodes verbatim', async () => {
    const founder = await findOrCreateEntity(root, 'Founder', 'person', '2026-05-18T10:20:00Z');
    const startup = await findOrCreateEntity(root, 'Startup', 'company', '2026-05-18T10:20:00Z');

    await linkEntitiesWithType(root, founder.id, startup.id, {
      relationship: 'founded',
      confidence: 0.9,
      rationale: 'mentioned in pitch deck',
      method: 'ai-extraction',
    });

    const db = await getEntityGraphDb(root);
    const row = db
      .prepare('SELECT arcana_edge_id FROM entity_relations WHERE source_id = ? AND target_id = ?')
      .get(founder.id, startup.id) as { arcana_edge_id: string | null };

    expect(row.arcana_edge_id).not.toBeNull();
  });

  it('mirrors deleteEntity to Arcana and removes the canonical row', async () => {
    const e = await findOrCreateEntity(root, 'ToDelete', 'topic', '2026-05-18T10:25:00Z');
    const arcanaId = e.arcana_entity_id!;

    let mirrored = await structured.getEntity(arcanaId);
    expect(mirrored).not.toBeNull();

    await deleteEntity(root, e.id, 'integration test cleanup', 'test');

    mirrored = await structured.getEntity(arcanaId);
    expect(mirrored).toBeNull();
  });
});
