import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock logger to suppress output during tests
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
  addEntityMention,
  linkEntities,
  searchEntities,
  getEntityContext,
  getEntityGraphStats,
  linkEntitiesFromConversation,
  getRecentEntities,
  getMostMentionedEntities,
  normalizeEntityName,
  addEntityAlias,
  mergeEntities,
  deleteEntity,
} = await import('./entity-graph.js');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-entity-test-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('normalizeEntityName', () => {
  it('should lowercase and trim', () => {
    expect(normalizeEntityName('  John Doe  ')).toBe('john doe');
  });

  it('should collapse whitespace', () => {
    expect(normalizeEntityName('John   Doe')).toBe('john doe');
  });
});

describe('findOrCreateEntity', () => {
  it('should create a new entity', async () => {
    const entity = await findOrCreateEntity(root, 'Alice', 'person', '2025-01-01T00:00:00Z');

    expect(entity.name).toBe('Alice');
    expect(entity.type).toBe('person');
    expect(entity.mention_count).toBe(1);
    expect(entity.normalized_name).toBe('alice');
    expect(entity.aliases).toEqual([]);
  });

  it('should return existing entity and increment mention_count', async () => {
    const entity = await findOrCreateEntity(root, 'Alice', 'person', '2025-01-02T00:00:00Z');

    expect(entity.name).toBe('Alice');
    expect(entity.mention_count).toBe(2);
    expect(entity.last_seen).toBe('2025-01-02T00:00:00Z');
  });

  it('should treat different types as different entities', async () => {
    const company = await findOrCreateEntity(root, 'Alice', 'company', '2025-01-01T00:00:00Z');

    expect(company.type).toBe('company');
    expect(company.mention_count).toBe(1);
  });
});

describe('addEntityMention', () => {
  it('should add a mention without error', async () => {
    const entity = await findOrCreateEntity(root, 'Bob', 'person', '2025-01-01T00:00:00Z');
    await expect(
      addEntityMention(root, entity.id, 'conv-1', '/test/path', 'mentioned Bob', '2025-01-01T00:00:00Z')
    ).resolves.toBeUndefined();
  });
});

describe('linkEntities', () => {
  it('should create a relationship between entities', async () => {
    const e1 = await findOrCreateEntity(root, 'Entity1', 'person', '2025-01-01T00:00:00Z');
    const e2 = await findOrCreateEntity(root, 'Entity2', 'company', '2025-01-01T00:00:00Z');

    await linkEntities(root, e1.id, e2.id, 'works_at');

    const context = await getEntityContext(root, e1.id);
    expect(context).not.toBeNull();
    expect(context!.related_entities.length).toBeGreaterThan(0);
  });

  it('should increment strength on duplicate link', async () => {
    const e1 = await findOrCreateEntity(root, 'LinkA', 'person', '2025-01-01T00:00:00Z');
    const e2 = await findOrCreateEntity(root, 'LinkB', 'person', '2025-01-01T00:00:00Z');

    await linkEntities(root, e1.id, e2.id);
    await linkEntities(root, e1.id, e2.id);

    const context = await getEntityContext(root, e1.id);
    const rel = context!.related_entities.find(r => r.entity.name === 'LinkB');
    expect(rel!.strength).toBe(2);
  });
});

describe('searchEntities', () => {
  it('should find entities by name', async () => {
    const results = await searchEntities(root, 'Alice');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe('Alice');
  });

  it('should filter by type', async () => {
    const results = await searchEntities(root, 'Alice', { type: 'company' });
    expect(results.every(r => r.type === 'company')).toBe(true);
  });

  it('should return empty for no matches', async () => {
    const results = await searchEntities(root, 'NonExistentEntity12345');
    expect(results).toEqual([]);
  });

  it('should respect limit', async () => {
    const results = await searchEntities(root, 'Entity', { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

describe('getEntityContext', () => {
  it('should return null for unknown entity', async () => {
    const ctx = await getEntityContext(root, 'ZZZ_DOES_NOT_EXIST');
    expect(ctx).toBeNull();
  });

  it('should return context by name', async () => {
    const ctx = await getEntityContext(root, 'Alice');
    expect(ctx).not.toBeNull();
    expect(ctx!.entity.name).toBe('Alice');
  });

  it('should return context by id', async () => {
    const entity = await findOrCreateEntity(root, 'ContextTest', 'topic', '2025-01-01T00:00:00Z');
    const ctx = await getEntityContext(root, entity.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.entity.id).toBe(entity.id);
  });
});

describe('getEntityGraphStats', () => {
  it('should return statistics', async () => {
    const stats = await getEntityGraphStats(root);
    expect(stats.total_entities).toBeGreaterThan(0);
    expect(stats.by_type).toHaveProperty('person');
    expect(stats.by_type).toHaveProperty('company');
    expect(typeof stats.total_mentions).toBe('number');
    expect(typeof stats.total_relations).toBe('number');
  });
});

describe('linkEntitiesFromConversation', () => {
  it('should link multiple entities from a conversation', async () => {
    await linkEntitiesFromConversation(root, 'conv-test', '/test', '2025-01-01T00:00:00Z', [
      { type: 'person', name: 'ConvPerson', context: 'test' },
      { type: 'company', name: 'ConvCompany', context: 'test' },
      { type: 'project', name: 'ConvProject', context: 'test' },
    ]);

    const stats = await getEntityGraphStats(root);
    expect(stats.total_entities).toBeGreaterThan(3);
  });

  it('should handle empty entities array', async () => {
    await expect(
      linkEntitiesFromConversation(root, 'conv-empty', '/test', '2025-01-01T00:00:00Z', [])
    ).resolves.toBeUndefined();
  });
});

describe('getRecentEntities', () => {
  it('should return entities sorted by last_seen', async () => {
    const entities = await getRecentEntities(root, 5);
    expect(entities.length).toBeGreaterThan(0);
    expect(entities.length).toBeLessThanOrEqual(5);
  });
});

describe('getMostMentionedEntities', () => {
  it('should return entities sorted by mention count', async () => {
    const entities = await getMostMentionedEntities(root, { limit: 5 });
    expect(entities.length).toBeGreaterThan(0);

    for (let i = 1; i < entities.length; i++) {
      expect(entities[i - 1].mention_count).toBeGreaterThanOrEqual(entities[i].mention_count);
    }
  });

  it('should filter by type', async () => {
    const entities = await getMostMentionedEntities(root, { type: 'person', limit: 10 });
    expect(entities.every(e => e.type === 'person')).toBe(true);
  });
});

describe('addEntityAlias', () => {
  it('should add an alias to an entity', async () => {
    const entity = await findOrCreateEntity(root, 'AliasTest', 'person', '2025-01-01T00:00:00Z');
    await addEntityAlias(root, entity.id, 'AT');

    const ctx = await getEntityContext(root, entity.id);
    expect(ctx!.entity.aliases).toContain('at');
  });

  it('should not duplicate aliases', async () => {
    const entity = await findOrCreateEntity(root, 'AliasTest', 'person', '2025-01-02T00:00:00Z');
    await addEntityAlias(root, entity.id, 'AT');
    await addEntityAlias(root, entity.id, 'AT');

    const ctx = await getEntityContext(root, entity.id);
    const count = ctx!.entity.aliases.filter((a: string) => a === 'at').length;
    expect(count).toBe(1);
  });
});

describe('mergeEntities', () => {
  it('should merge two entities', async () => {
    const keep = await findOrCreateEntity(root, 'MergeKeep', 'person', '2025-01-01T00:00:00Z');
    const remove = await findOrCreateEntity(root, 'MergeRemove', 'person', '2025-01-01T00:00:00Z');
    await addEntityMention(root, remove.id, 'conv-merge', '/merge', 'test', '2025-01-01T00:00:00Z');

    const result = await mergeEntities(root, keep.id, remove.id, 'duplicate');

    expect(result.mentionsMoved).toBeGreaterThanOrEqual(0);

    // The removed entity should no longer exist
    const ctx = await getEntityContext(root, remove.id);
    expect(ctx).toBeNull();
  });

  it('should throw for non-existent entities', async () => {
    await expect(mergeEntities(root, 999999, 999998, 'test'))
      .rejects.toThrow('Entity not found');
  });
});

describe('deleteEntity', () => {
  it('should delete an entity', async () => {
    const entity = await findOrCreateEntity(root, 'ToDelete', 'topic', '2025-01-01T00:00:00Z');
    await deleteEntity(root, entity.id, 'test cleanup');

    const ctx = await getEntityContext(root, entity.id);
    expect(ctx).toBeNull();
  });

  it('should handle non-existent entity gracefully', async () => {
    await expect(deleteEntity(root, 999999, 'test'))
      .resolves.toBeUndefined();
  });
});
