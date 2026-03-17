import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock logger
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock config
vi.mock('../config.js', () => ({
  getRoot: () => '/tmp/test-root',
}));

// Mock semanticSearch
const mockSemanticSearch = vi.fn();
vi.mock('./embeddings.js', () => ({
  semanticSearch: (...args: unknown[]) => mockSemanticSearch(...args),
}));

const { getTimelineDb } = await import('./timeline.js');
const { getSleepDb } = await import('./sleep/db.js');
const { hybridSearch } = await import('./hybrid-search.js');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-hybrid-test-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function insertEvent(opts: {
  title: string;
  summary?: string;
  timestamp?: string;
  type?: string;
  source_path?: string;
  priority?: number;
  tier?: string;
  tags_json?: string;
  entities_json?: string;
}): Promise<number> {
  const db = await getTimelineDb(root);
  const result = db.prepare(`
    INSERT INTO timeline_events (type, timestamp, title, summary, source_path, priority, tier, tags_json, entities_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.type || 'note',
    opts.timestamp || new Date().toISOString(),
    opts.title,
    opts.summary || 'test summary',
    opts.source_path || `test/${opts.title.replace(/\s/g, '-')}.md`,
    opts.priority ?? 0.5,
    opts.tier || 'warm',
    opts.tags_json || '[]',
    opts.entities_json || '[]',
  );
  return result.lastInsertRowid as number;
}

function insertEdge(fromPath: string, toPath: string, confidence = 0.5): void {
  const sleep = getSleepDb(root);
  sleep.prepare(`
    INSERT INTO memory_edges (from_path, to_path, relation, confidence, created_at, last_verified)
    VALUES (?, ?, 'related', ?, datetime('now'), datetime('now'))
  `).run(fromPath, toPath, confidence);
}

beforeEach(async () => {
  vi.resetModules();
  mockSemanticSearch.mockReset();
  const db = await getTimelineDb(root);
  db.exec('DELETE FROM timeline_events');
  try {
    const sleep = getSleepDb(root);
    sleep.exec('DELETE FROM memory_edges');
  } catch {
    // sleep db may not exist yet
  }
});

describe('hybridSearch', () => {
  it('should return empty results for query with no matches', async () => {
    mockSemanticSearch.mockResolvedValue([]);
    const results = await hybridSearch('nonexistent query', root);
    expect(results).toEqual([]);
  });

  it('should return keyword-only results when semantic search fails', async () => {
    mockSemanticSearch.mockRejectedValue(new Error('ChromaDB unavailable'));

    await insertEvent({
      title: 'Meeting about pricing strategy',
      summary: 'Discussed new pricing tiers',
      tags_json: '["pricing", "strategy", "meeting"]',
    });

    const results = await hybridSearch('pricing strategy', root);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchType).toBe('keyword');
    expect(results[0].semanticScore).toBe(0);
    expect(results[0].metadataScore).toBeGreaterThan(0);
  });

  it('should return semantic-only results when no keyword matches', async () => {
    mockSemanticSearch.mockResolvedValue([
      {
        id: 'vec-1',
        content: 'Discussion about AI architecture',
        metadata: {
          source_path: 'notes/ai-arch.md',
          title: 'AI Architecture',
          timestamp: new Date().toISOString(),
          type: 'note',
        },
        distance: 0.2,
      },
    ]);

    const results = await hybridSearch('artificial intelligence design', root);
    expect(results.length).toBe(1);
    expect(results[0].matchType).toBe('semantic');
    expect(results[0].semanticScore).toBeGreaterThan(0);
  });

  it('should merge results appearing in both semantic and keyword', async () => {
    const sourcePath = 'notes/pricing.md';
    const timestamp = new Date().toISOString();

    await insertEvent({
      title: 'Pricing discussion',
      summary: 'Talked about pricing models',
      source_path: sourcePath,
      timestamp,
      tags_json: '["pricing", "business"]',
      tier: 'hot',
      priority: 0.8,
    });

    mockSemanticSearch.mockResolvedValue([
      {
        id: 'vec-pricing',
        content: 'Pricing model discussion',
        metadata: {
          source_path: sourcePath,
          title: 'Pricing discussion',
          timestamp,
          type: 'note',
        },
        distance: 0.15,
      },
    ]);

    const results = await hybridSearch('pricing', root);
    expect(results.length).toBe(1);
    expect(results[0].matchType).toBe('both');
    expect(results[0].semanticScore).toBeGreaterThan(0);
    expect(results[0].metadataScore).toBeGreaterThan(0);
    expect(results[0].hybridScore).toBeGreaterThan(results[0].semanticScore * 0.7);
  });

  it('should respect limit option', async () => {
    mockSemanticSearch.mockResolvedValue([]);

    for (let i = 0; i < 10; i++) {
      await insertEvent({
        title: `Meeting note ${i}`,
        summary: `Discussion about topic ${i} in the meeting`,
        tags_json: '["meeting"]',
      });
    }

    const results = await hybridSearch('meeting', root, { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('should filter by tier', async () => {
    mockSemanticSearch.mockResolvedValue([]);

    await insertEvent({ title: 'Hot memory about deploy', summary: 'deploy info', tier: 'hot', tags_json: '["deploy"]' });
    await insertEvent({ title: 'Archive memory about deploy', summary: 'old deploy info', tier: 'archive', tags_json: '["deploy"]' });

    const results = await hybridSearch('deploy', root, { tier: 'hot' });
    expect(results.every(r => r.tier === 'hot')).toBe(true);
  });

  it('should filter by minimum priority', async () => {
    mockSemanticSearch.mockResolvedValue([]);

    await insertEvent({ title: 'High priority item', summary: 'important meeting discussion', priority: 0.9, tags_json: '["meeting"]' });
    await insertEvent({ title: 'Low priority item', summary: 'routine meeting discussion', priority: 0.1, tags_json: '["meeting"]' });

    const results = await hybridSearch('meeting', root, { minPriority: 0.5 });
    expect(results.every(r => (r.priority || 0) >= 0.5)).toBe(true);
  });

  it('should filter by type', async () => {
    mockSemanticSearch.mockResolvedValue([]);

    await insertEvent({ title: 'A conversation about code', summary: 'code discussion', type: 'conversation', tags_json: '["code"]' });
    await insertEvent({ title: 'A note about code', summary: 'code reference', type: 'note', tags_json: '["code"]' });

    const results = await hybridSearch('code', root, { type: 'note' });
    expect(results.every(r => r.type === 'note')).toBe(true);
  });

  it('should filter by entity with "all" match mode', async () => {
    mockSemanticSearch.mockResolvedValue([]);

    await insertEvent({
      title: 'Meeting with Alice and Bob',
      summary: 'Alice and Bob discussed the project',
      tags_json: '["alice", "bob", "meeting"]',
    });
    await insertEvent({
      title: 'Meeting with Alice only',
      summary: 'Alice reviewed the code',
      tags_json: '["alice", "meeting"]',
    });

    const results = await hybridSearch('meeting', root, {
      entity: 'alice,bob',
      entityMatch: 'all',
    });
    // Only the result with both alice AND bob should pass
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Meeting with Alice and Bob');
  });

  it('should filter by entity with "any" match mode', async () => {
    mockSemanticSearch.mockResolvedValue([]);

    await insertEvent({
      title: 'Meeting with Alice',
      summary: 'Alice did stuff',
      tags_json: '["alice", "meeting"]',
    });
    await insertEvent({
      title: 'Meeting with Bob',
      summary: 'Bob did stuff',
      tags_json: '["bob", "meeting"]',
    });
    await insertEvent({
      title: 'Meeting with Charlie',
      summary: 'Charlie did stuff',
      tags_json: '["charlie", "meeting"]',
    });

    const results = await hybridSearch('meeting', root, {
      entity: 'alice,bob',
      entityMatch: 'any',
    });
    expect(results.length).toBe(2);
  });

  it('should filter by time range', async () => {
    mockSemanticSearch.mockResolvedValue([]);

    const old = new Date('2024-01-01').toISOString();
    const recent = new Date('2025-06-15').toISOString();

    await insertEvent({ title: 'Old planning event', summary: 'planning details', timestamp: old, tags_json: '["planning"]' });
    await insertEvent({ title: 'Recent planning event', summary: 'planning details', timestamp: recent, tags_json: '["planning"]' });

    const results = await hybridSearch('planning', root, {
      after: new Date('2025-01-01'),
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Recent planning event');
  });

  it('should add related memories from sleep edges', async () => {
    mockSemanticSearch.mockResolvedValue([]);
    const mainPath = 'notes/main-topic.md';
    const relatedPath = 'notes/related-topic.md';

    await insertEvent({
      title: 'Main topic discussion',
      summary: 'Important main topic',
      source_path: mainPath,
      tags_json: '["main", "topic"]',
    });

    // Initialize sleep db and add edge
    getSleepDb(root);
    insertEdge(mainPath, relatedPath, 0.8);

    const results = await hybridSearch('main topic', root, { includeRelated: true });
    expect(results.length).toBe(1);
    expect(results[0].relatedMemories).toBeDefined();
    expect(results[0].relatedMemories).toContain(relatedPath);
  });

  it('should skip related memories when includeRelated is false', async () => {
    mockSemanticSearch.mockResolvedValue([]);
    const mainPath = 'notes/solo-topic.md';

    await insertEvent({
      title: 'Solo topic note',
      summary: 'Solo content here',
      source_path: mainPath,
      tags_json: '["solo", "topic"]',
    });

    getSleepDb(root);
    insertEdge(mainPath, 'notes/other.md', 0.9);

    const results = await hybridSearch('solo topic', root, { includeRelated: false });
    expect(results.length).toBe(1);
    expect(results[0].relatedMemories).toBeUndefined();
  });

  it('should handle words shorter than 3 chars in keyword search', async () => {
    mockSemanticSearch.mockResolvedValue([]);

    await insertEvent({
      title: 'AI ML topic',
      summary: 'artificial intelligence and machine learning',
      tags_json: '["artificial", "intelligence"]',
    });

    // "AI" and "ML" are < 3 chars, should be filtered from keyword search
    const results = await hybridSearch('AI ML', root);
    // Should still work but keyword search returns empty (words too short)
    expect(results).toEqual([]);
  });

  it('should keep best semantic chunk when duplicates exist', async () => {
    const sourcePath = 'notes/chunked.md';

    mockSemanticSearch.mockResolvedValue([
      {
        id: 'chunk-1',
        content: 'First chunk of the document',
        metadata: { source_path: sourcePath, title: 'Chunked Doc', timestamp: new Date().toISOString(), type: 'note' },
        distance: 0.3,
      },
      {
        id: 'chunk-2',
        content: 'Better matching chunk',
        metadata: { source_path: sourcePath, title: 'Chunked Doc', timestamp: new Date().toISOString(), type: 'note' },
        distance: 0.1, // closer = better
      },
    ]);

    const results = await hybridSearch('test query', root);
    expect(results.length).toBe(1);
    expect(results[0].content).toBe('Better matching chunk');
  });

  it('should sort results by hybrid score descending', async () => {
    mockSemanticSearch.mockResolvedValue([]);

    await insertEvent({
      title: 'High relevance deploy item',
      summary: 'deploy deploy deploy critical deploy',
      tags_json: '["deploy", "critical"]',
      priority: 0.9,
      tier: 'hot',
    });

    await insertEvent({
      title: 'Low relevance deploy mention',
      summary: 'something about deploy',
      tags_json: '["misc"]',
      priority: 0.2,
      tier: 'archive',
    });

    const results = await hybridSearch('deploy', root);
    if (results.length >= 2) {
      expect(results[0].hybridScore).toBeGreaterThanOrEqual(results[1].hybridScore);
    }
  });

  it('should enrich semantic-only results with timeline metadata', async () => {
    const sourcePath = 'notes/enrichable.md';

    await insertEvent({
      title: 'Enrichable item',
      summary: 'Has metadata in timeline',
      source_path: sourcePath,
      tier: 'hot',
      priority: 0.9,
      tags_json: '["enriched", "important"]',
    });

    mockSemanticSearch.mockResolvedValue([
      {
        id: 'vec-enrich',
        content: 'Content from vector search',
        metadata: {
          source_path: sourcePath,
          title: 'Enrichable item',
          timestamp: new Date().toISOString(),
          type: 'note',
        },
        distance: 0.2,
      },
    ]);

    const results = await hybridSearch('enrichable', root);
    expect(results.length).toBe(1);
    expect(results[0].tier).toBe('hot');
    expect(results[0].priority).toBe(0.9);
    expect(results[0].tags).toContain('enriched');
  });

  it('should handle custom semantic/metadata weights', async () => {
    const sourcePath = 'notes/weighted.md';

    await insertEvent({
      title: 'Weighted test item',
      summary: 'keyword match here for weighted test',
      source_path: sourcePath,
      tags_json: '["weighted", "test"]',
    });

    mockSemanticSearch.mockResolvedValue([
      {
        id: 'vec-w',
        content: 'semantic match for weighted test',
        metadata: {
          source_path: sourcePath,
          title: 'Weighted test item',
          timestamp: new Date().toISOString(),
          type: 'note',
        },
        distance: 0.2,
      },
    ]);

    const metaHeavy = await hybridSearch('weighted test', root, {
      semanticWeight: 0.1,
      metadataWeight: 0.9,
    });

    const semHeavy = await hybridSearch('weighted test', root, {
      semanticWeight: 0.9,
      metadataWeight: 0.1,
    });

    // Both should return results but with different score distributions
    expect(metaHeavy.length).toBeGreaterThan(0);
    expect(semHeavy.length).toBeGreaterThan(0);
  });
});
