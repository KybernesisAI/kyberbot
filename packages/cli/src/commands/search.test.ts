import { describe, it, expect, vi } from 'vitest';

// Mock logger
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock external dependencies used by the command module
vi.mock('../brain/embeddings.js', () => ({
  semanticSearch: vi.fn(),
  isChromaAvailable: vi.fn(),
  initializeEmbeddings: vi.fn(),
}));
vi.mock('../brain/hybrid-search.js', () => ({
  hybridSearch: vi.fn(),
}));
vi.mock('../brain/timeline.js', () => ({
  getTimelineDb: vi.fn(),
}));
vi.mock('../utils/date-parser.js', () => ({
  parseNaturalDate: vi.fn(),
}));
vi.mock('../config.js', () => ({
  getRoot: () => '/tmp/test',
}));

import type { SearchResult } from '../brain/embeddings.js';

const { groupResultsByDocument, filterByEntity, filterByTime } = await import('./search.js');

// Helper: create a mock SearchResult
function mockResult(overrides: Partial<{
  id: string;
  content: string;
  distance: number;
  source_path: string;
  title: string;
  type: string;
  timestamp: string;
  entities: string[];
  topics: string[];
}>): SearchResult {
  return {
    id: overrides.id ?? 'doc-1',
    content: overrides.content ?? 'test content',
    distance: overrides.distance ?? 0.3,
    metadata: {
      type: (overrides.type ?? 'note') as SearchResult['metadata']['type'],
      source_path: overrides.source_path ?? 'test.md',
      title: overrides.title ?? 'Test',
      timestamp: overrides.timestamp ?? '2026-01-15T10:00:00Z',
      entities: overrides.entities,
      topics: overrides.topics,
    },
  };
}

describe('groupResultsByDocument', () => {
  it('should group chunks by source_path', () => {
    const results = [
      mockResult({ id: 'doc-1_chunk_0', source_path: 'a.md', distance: 0.2, content: 'chunk 1' }),
      mockResult({ id: 'doc-1_chunk_1', source_path: 'a.md', distance: 0.4, content: 'chunk 2' }),
      mockResult({ id: 'doc-2_chunk_0', source_path: 'b.md', distance: 0.3, content: 'other doc' }),
    ];

    const grouped = groupResultsByDocument(results);
    expect(grouped).toHaveLength(2);
  });

  it('should keep the best scoring chunk per document', () => {
    const results = [
      mockResult({ source_path: 'a.md', distance: 0.5, content: 'worse chunk' }),
      mockResult({ source_path: 'a.md', distance: 0.1, content: 'best chunk' }),
      mockResult({ source_path: 'a.md', distance: 0.3, content: 'middle chunk' }),
    ];

    const grouped = groupResultsByDocument(results);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].bestMatch.content).toBe('best chunk');
    expect(grouped[0].bestScore).toBeCloseTo(0.9); // 1 - 0.1
    expect(grouped[0].allChunks).toHaveLength(3);
  });

  it('should sort groups by best score descending', () => {
    const results = [
      mockResult({ source_path: 'low.md', distance: 0.8 }),
      mockResult({ source_path: 'high.md', distance: 0.1 }),
      mockResult({ source_path: 'mid.md', distance: 0.4 }),
    ];

    const grouped = groupResultsByDocument(results);
    expect(grouped[0].sourcePath).toBe('high.md');
    expect(grouped[1].sourcePath).toBe('mid.md');
    expect(grouped[2].sourcePath).toBe('low.md');
  });

  it('should merge entities from multiple chunks', () => {
    const results = [
      mockResult({ source_path: 'a.md', entities: ['alice', 'bob'] }),
      mockResult({ source_path: 'a.md', entities: ['bob', 'charlie'] }),
    ];

    const grouped = groupResultsByDocument(results);
    expect(grouped[0].entities).toContain('alice');
    expect(grouped[0].entities).toContain('bob');
    expect(grouped[0].entities).toContain('charlie');
    // Deduplicated
    expect(grouped[0].entities).toHaveLength(3);
  });

  it('should handle empty results', () => {
    expect(groupResultsByDocument([])).toEqual([]);
  });

  it('should use title from metadata', () => {
    const results = [mockResult({ source_path: 'a.md', title: 'My Note' })];
    const grouped = groupResultsByDocument(results);
    expect(grouped[0].title).toBe('My Note');
  });

  it('should default title to Untitled', () => {
    const results = [mockResult({ source_path: 'a.md', title: '' })];
    const grouped = groupResultsByDocument(results);
    expect(grouped[0].title).toBe('Untitled');
  });
});

describe('filterByEntity', () => {
  const results = [
    mockResult({ source_path: 'a.md', entities: ['Alice', 'Bob'] }),
    mockResult({ source_path: 'b.md', entities: ['Bob', 'Charlie'] }),
    mockResult({ source_path: 'c.md', entities: ['Charlie', 'Diana'] }),
    mockResult({ source_path: 'd.md', entities: undefined }),
  ];

  it('should return all results when entity is empty', () => {
    expect(filterByEntity(results, '')).toHaveLength(4);
  });

  it('should filter by single entity (case insensitive)', () => {
    const filtered = filterByEntity(results, 'alice');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].metadata.source_path).toBe('a.md');
  });

  it('should use AND logic by default for multiple entities', () => {
    const filtered = filterByEntity(results, 'Bob,Charlie');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].metadata.source_path).toBe('b.md');
  });

  it('should support OR logic with any match mode', () => {
    const filtered = filterByEntity(results, 'Alice,Charlie', 'any');
    expect(filtered).toHaveLength(3); // a.md, b.md, c.md
  });

  it('should match partial entity names', () => {
    const filtered = filterByEntity(results, 'char');
    expect(filtered).toHaveLength(2); // b.md, c.md
  });

  it('should exclude results with no entities', () => {
    const filtered = filterByEntity(results, 'anyone');
    // d.md has no entities, should not match
    expect(filtered.every(r => r.metadata.entities && r.metadata.entities.length > 0)).toBe(true);
  });

  it('should handle whitespace in entity list', () => {
    const filtered = filterByEntity(results, ' Alice , Bob ');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].metadata.source_path).toBe('a.md');
  });
});

describe('filterByTime', () => {
  const results = [
    mockResult({ source_path: 'old.md', timestamp: '2026-01-01T00:00:00Z' }),
    mockResult({ source_path: 'mid.md', timestamp: '2026-01-15T00:00:00Z' }),
    mockResult({ source_path: 'new.md', timestamp: '2026-01-30T00:00:00Z' }),
  ];

  it('should return all results when no filters', () => {
    expect(filterByTime(results)).toHaveLength(3);
  });

  it('should filter by after date', () => {
    const after = new Date('2026-01-10T00:00:00Z');
    const filtered = filterByTime(results, after);
    expect(filtered).toHaveLength(2);
    expect(filtered[0].metadata.source_path).toBe('mid.md');
  });

  it('should filter by before date', () => {
    const before = new Date('2026-01-20T00:00:00Z');
    const filtered = filterByTime(results, undefined, before);
    expect(filtered).toHaveLength(2);
    expect(filtered[1].metadata.source_path).toBe('mid.md');
  });

  it('should filter by both after and before', () => {
    const after = new Date('2026-01-10T00:00:00Z');
    const before = new Date('2026-01-20T00:00:00Z');
    const filtered = filterByTime(results, after, before);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].metadata.source_path).toBe('mid.md');
  });

  it('should exclude exact boundary on after', () => {
    const after = new Date('2026-01-15T00:00:00Z');
    const filtered = filterByTime(results, after);
    // Timestamp equal to after should pass (not strictly after)
    expect(filtered).toHaveLength(2);
  });

  it('should handle empty results', () => {
    expect(filterByTime([], new Date())).toEqual([]);
  });
});
