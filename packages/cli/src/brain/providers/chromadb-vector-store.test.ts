import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChromaDBVectorStore } from './chromadb-vector-store.js';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

interface FakeCollection {
  count: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

interface FakeClient {
  heartbeat: ReturnType<typeof vi.fn>;
  getOrCreateCollection: ReturnType<typeof vi.fn>;
  __collection: FakeCollection;
}

function makeFakeClient(): FakeClient {
  const col: FakeCollection = {
    count: vi.fn(async () => 0),
    upsert: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ ids: [[]], distances: [[]], metadatas: [[]] })),
    delete: vi.fn(async () => undefined),
  };
  return {
    heartbeat: vi.fn(async () => true),
    getOrCreateCollection: vi.fn(async () => col),
    __collection: col,
  };
}

let client: FakeClient;

beforeEach(() => {
  client = makeFakeClient();
});

describe('createChromaDBVectorStore', () => {
  it('connects and gets-or-creates the named collection on connect()', async () => {
    const store = createChromaDBVectorStore({
      collectionName: 'unit_test_col',
      client: client as never,
    });
    await store.connect();
    expect(client.heartbeat).toHaveBeenCalled();
    expect(client.getOrCreateCollection).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'unit_test_col',
        metadata: expect.objectContaining({ 'hnsw:space': 'cosine' }),
      }),
    );
  });

  it('refuses operations before connect()', async () => {
    const store = createChromaDBVectorStore({
      collectionName: 'unit_test_col',
      client: client as never,
    });
    await expect(store.upsert([{ id: 'a', vector: [1, 2] }])).rejects.toThrow(/connect/);
  });

  it('upsert() forwards ids/embeddings/metadatas to the collection', async () => {
    const store = createChromaDBVectorStore({
      collectionName: 'unit_test_col',
      client: client as never,
    });
    await store.connect();
    await store.upsert([
      { id: 'a', vector: [0.1, 0.2], metadata: { tag: 'foo' } },
      { id: 'b', vector: [0.3, 0.4] },
    ]);
    expect(client.__collection.upsert).toHaveBeenCalledWith({
      ids: ['a', 'b'],
      embeddings: [[0.1, 0.2], [0.3, 0.4]],
      metadatas: [{ tag: 'foo' }, {}],
    });
  });

  it('upsert([]) short-circuits', async () => {
    const store = createChromaDBVectorStore({
      collectionName: 'unit_test_col',
      client: client as never,
    });
    await store.connect();
    await store.upsert([]);
    expect(client.__collection.upsert).not.toHaveBeenCalled();
  });

  it('query() returns matches with cosine score normalization (1 - d/2)', async () => {
    client.__collection.query.mockResolvedValueOnce({
      ids: [['a', 'b']],
      distances: [[0, 1]],
      metadatas: [[{ k: 'v1' }, { k: 'v2' }]],
    });
    const store = createChromaDBVectorStore({
      collectionName: 'unit_test_col',
      client: client as never,
    });
    await store.connect();
    const matches = await store.query([0.1, 0.2], { topK: 5 });

    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ id: 'a', score: 1, metadata: { k: 'v1' } });
    expect(matches[1]).toEqual({ id: 'b', score: 0.5, metadata: { k: 'v2' } });
    expect(client.__collection.query).toHaveBeenCalledWith({
      queryEmbeddings: [[0.1, 0.2]],
      nResults: 5,
      where: undefined,
    });
  });

  it('query() forwards filter as where', async () => {
    const store = createChromaDBVectorStore({
      collectionName: 'unit_test_col',
      client: client as never,
    });
    await store.connect();
    await store.query([0.1], { filter: { project_id: 'alpha' } });
    expect(client.__collection.query).toHaveBeenCalledWith(
      expect.objectContaining({ where: { project_id: 'alpha' } }),
    );
  });

  it('delete() forwards ids to the collection', async () => {
    const store = createChromaDBVectorStore({
      collectionName: 'unit_test_col',
      client: client as never,
    });
    await store.connect();
    await store.delete(['a', 'b', 'c']);
    expect(client.__collection.delete).toHaveBeenCalledWith({ ids: ['a', 'b', 'c'] });
  });

  it('delete([]) short-circuits', async () => {
    const store = createChromaDBVectorStore({
      collectionName: 'unit_test_col',
      client: client as never,
    });
    await store.connect();
    await store.delete([]);
    expect(client.__collection.delete).not.toHaveBeenCalled();
  });

  it('disconnect() forces re-connect before next op', async () => {
    const store = createChromaDBVectorStore({
      collectionName: 'unit_test_col',
      client: client as never,
    });
    await store.connect();
    await store.disconnect();
    await expect(store.upsert([{ id: 'x', vector: [1] }])).rejects.toThrow(/connect/);
  });

  it('l2 space uses 1 / (1 + distance) scoring', async () => {
    client.__collection.query.mockResolvedValueOnce({
      ids: [['a']],
      distances: [[1]],
      metadatas: [[{}]],
    });
    const store = createChromaDBVectorStore({
      collectionName: 'unit_test_col',
      client: client as never,
      space: 'l2',
    });
    await store.connect();
    const [m] = await store.query([0.1]);
    expect(m.score).toBeCloseTo(0.5);
  });
});
