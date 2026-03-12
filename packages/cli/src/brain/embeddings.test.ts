import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock OpenAI
const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: class {
    embeddings = { create: mockCreate };
  },
}));

// Mock ChromaDB
const mockHeartbeat = vi.fn();
const mockGetOrCreateCollection = vi.fn();
const mockCollectionCount = vi.fn();
const mockCollectionUpsert = vi.fn();
const mockCollectionQuery = vi.fn();

vi.mock('chromadb', () => ({
  ChromaClient: class {
    heartbeat = mockHeartbeat;
    getOrCreateCollection = mockGetOrCreateCollection;
  },
}));

// We need to reset module state between tests since embeddings.ts uses module-level singletons
beforeEach(() => {
  vi.resetModules();
  mockCreate.mockReset();
  mockHeartbeat.mockReset();
  mockGetOrCreateCollection.mockReset();
  mockCollectionCount.mockReset();
  mockCollectionUpsert.mockReset();
  mockCollectionQuery.mockReset();
});

describe('chunkText (via indexDocument)', () => {
  // chunkText is private, but we can test it indirectly through indexDocument.
  // First, let's test the public API with mocked externals.

  it('should skip indexing when content is too short', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    // Re-import after setting env
    const { indexDocument, initializeEmbeddings } = await import('./embeddings.js');

    // Set up ChromaDB mock
    mockHeartbeat.mockResolvedValue(true);
    mockCollectionCount.mockResolvedValue(0);
    mockGetOrCreateCollection.mockResolvedValue({
      count: mockCollectionCount,
      upsert: mockCollectionUpsert,
      query: mockCollectionQuery,
    });

    await initializeEmbeddings();

    const count = await indexDocument('doc-1', 'short', {
      type: 'note',
      source_path: 'test.md',
      timestamp: new Date().toISOString(),
    });

    expect(count).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('should skip indexing when ChromaDB is not available', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const { indexDocument, initializeEmbeddings } = await import('./embeddings.js');

    // ChromaDB heartbeat fails
    mockHeartbeat.mockRejectedValue(new Error('Connection refused'));

    await initializeEmbeddings();

    const count = await indexDocument('doc-2', 'This is a document with enough content to index.', {
      type: 'note',
      source_path: 'test2.md',
      timestamp: new Date().toISOString(),
    });

    expect(count).toBe(0);
  });

  it('should chunk and index a document when ChromaDB is available', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const { indexDocument, initializeEmbeddings } = await import('./embeddings.js');

    mockHeartbeat.mockResolvedValue(true);
    mockCollectionCount.mockResolvedValue(0);
    mockCollectionUpsert.mockResolvedValue(undefined);
    mockGetOrCreateCollection.mockResolvedValue({
      count: mockCollectionCount,
      upsert: mockCollectionUpsert,
      query: mockCollectionQuery,
    });

    await initializeEmbeddings();

    // Mock embedding generation
    mockCreate.mockResolvedValue({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    });

    const content = 'This is a test document with enough content to be indexed properly. It has multiple sentences to verify chunking behavior.';

    const count = await indexDocument('doc-3', content, {
      type: 'note',
      source_path: 'test3.md',
      title: 'Test Doc',
      timestamp: new Date().toISOString(),
    });

    expect(count).toBeGreaterThan(0);
    expect(mockCollectionUpsert).toHaveBeenCalled();

    const upsertCall = mockCollectionUpsert.mock.calls[0][0];
    expect(upsertCall.ids.length).toBeGreaterThan(0);
    expect(upsertCall.ids[0]).toContain('doc-3_chunk_');
    expect(upsertCall.metadatas[0].parent_id).toBe('doc-3');
  });

  it('should create multiple chunks for long content', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const { indexDocument, initializeEmbeddings } = await import('./embeddings.js');

    mockHeartbeat.mockResolvedValue(true);
    mockCollectionCount.mockResolvedValue(0);
    mockCollectionUpsert.mockResolvedValue(undefined);
    mockGetOrCreateCollection.mockResolvedValue({
      count: mockCollectionCount,
      upsert: mockCollectionUpsert,
      query: mockCollectionQuery,
    });

    await initializeEmbeddings();

    // Generate a long document with many sentences
    const sentences = Array.from({ length: 30 }, (_, i) =>
      `This is sentence number ${i + 1} in our test document.`
    );
    const longContent = sentences.join(' ');

    mockCreate.mockResolvedValue({
      data: sentences.map(() => ({ embedding: [0.1, 0.2] })),
    });

    const count = await indexDocument('doc-4', longContent, {
      type: 'note',
      source_path: 'test4.md',
      timestamp: new Date().toISOString(),
    });

    // With 30 sentences of ~50 chars each (total ~1500 chars), chunk size 500
    // should produce at least 2 chunks
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

describe('initializeEmbeddings', () => {
  it('should return false when OPENAI_API_KEY is not set', async () => {
    delete process.env.OPENAI_API_KEY;
    const { initializeEmbeddings } = await import('./embeddings.js');

    const result = await initializeEmbeddings();
    expect(result).toBe(false);
  });

  it('should return false when ChromaDB is unreachable', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const { initializeEmbeddings } = await import('./embeddings.js');

    mockHeartbeat.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await initializeEmbeddings();
    expect(result).toBe(false);
  });

  it('should return true when everything is configured', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const { initializeEmbeddings } = await import('./embeddings.js');

    mockHeartbeat.mockResolvedValue(true);
    mockCollectionCount.mockResolvedValue(42);
    mockGetOrCreateCollection.mockResolvedValue({
      count: mockCollectionCount,
      upsert: mockCollectionUpsert,
      query: mockCollectionQuery,
    });

    const result = await initializeEmbeddings();
    expect(result).toBe(true);
  });

  it('should only initialize once (cached)', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const { initializeEmbeddings } = await import('./embeddings.js');

    mockHeartbeat.mockResolvedValue(true);
    mockCollectionCount.mockResolvedValue(0);
    mockGetOrCreateCollection.mockResolvedValue({
      count: mockCollectionCount,
      upsert: mockCollectionUpsert,
      query: mockCollectionQuery,
    });

    await initializeEmbeddings();
    await initializeEmbeddings();

    // Heartbeat should only be called once due to caching
    expect(mockHeartbeat).toHaveBeenCalledTimes(1);
  });
});

describe('semanticSearch', () => {
  it('should return empty array when ChromaDB is not available', async () => {
    delete process.env.OPENAI_API_KEY;
    const { semanticSearch, initializeEmbeddings } = await import('./embeddings.js');

    await initializeEmbeddings();
    const results = await semanticSearch('test query');
    expect(results).toEqual([]);
  });

  it('should query ChromaDB and return formatted results', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const { semanticSearch, initializeEmbeddings } = await import('./embeddings.js');

    mockHeartbeat.mockResolvedValue(true);
    mockCollectionCount.mockResolvedValue(5);
    mockGetOrCreateCollection.mockResolvedValue({
      count: mockCollectionCount,
      upsert: mockCollectionUpsert,
      query: mockCollectionQuery,
    });

    await initializeEmbeddings();

    // Mock embedding for query
    mockCreate.mockResolvedValue({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    });

    // Mock ChromaDB query response
    mockCollectionQuery.mockResolvedValue({
      ids: [['doc-1_chunk_0']],
      documents: [['This is a test document.']],
      metadatas: [[{
        type: 'note',
        source_path: 'test.md',
        title: 'Test Note',
        timestamp: '2026-01-01T00:00:00Z',
        parent_id: 'doc-1',
        entities: 'alice,bob',
        topics: 'testing',
      }]],
      distances: [[0.2]],
    });

    const results = await semanticSearch('test query');

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('doc-1');
    expect(results[0].content).toBe('This is a test document.');
    expect(results[0].metadata.type).toBe('note');
    expect(results[0].metadata.entities).toEqual(['alice', 'bob']);
    expect(results[0].metadata.topics).toEqual(['testing']);
    expect(results[0].distance).toBe(0.2);
  });
});

describe('isChromaAvailable', () => {
  it('should return false before initialization', async () => {
    const { isChromaAvailable } = await import('./embeddings.js');
    expect(isChromaAvailable()).toBe(false);
  });
});

describe('getIndexStats', () => {
  it('should return unavailable stats when ChromaDB is not connected', async () => {
    delete process.env.OPENAI_API_KEY;
    const { getIndexStats, initializeEmbeddings } = await import('./embeddings.js');

    await initializeEmbeddings();
    const stats = await getIndexStats();
    expect(stats.available).toBe(false);
    expect(stats.totalChunks).toBe(0);
  });
});
