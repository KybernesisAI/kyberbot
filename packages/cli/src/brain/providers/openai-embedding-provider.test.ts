import { describe, it, expect, vi } from 'vitest';
import { createOpenAIEmbeddingProvider } from './openai-embedding-provider.js';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeFakeClient(behavior: (input: string | string[]) => number[][]): { embeddings: { create: ReturnType<typeof vi.fn> } } {
  return {
    embeddings: {
      create: vi.fn(async ({ input }: { input: string | string[] }) => {
        const vectors = behavior(input);
        return { data: vectors.map(v => ({ embedding: v })) };
      }),
    },
  };
}

describe('createOpenAIEmbeddingProvider', () => {
  it('exposes model + dimensions for known models', () => {
    const p = createOpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
    });
    expect(p.model).toBe('text-embedding-3-small');
    expect(p.dimensions).toBe(1536);
  });

  it('defaults to text-embedding-3-large', () => {
    const p = createOpenAIEmbeddingProvider({ apiKey: 'sk-test' });
    expect(p.model).toBe('text-embedding-3-large');
    expect(p.dimensions).toBe(3072);
  });

  it('accepts explicit dimensions for unknown models', () => {
    const p = createOpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      model: 'custom-model',
      dimensions: 768,
    });
    expect(p.dimensions).toBe(768);
  });

  it('throws when an unknown model has no explicit dimensions', () => {
    expect(() => createOpenAIEmbeddingProvider({ apiKey: 'sk-test', model: 'custom-model' })).toThrow(/dimensions/);
  });

  it('throws when API key is missing and no client injected', () => {
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => createOpenAIEmbeddingProvider({})).toThrow(/OPENAI_API_KEY/);
    } finally {
      if (prevKey) process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it('embed() returns a single vector', async () => {
    const fakeClient = makeFakeClient(() => [[0.1, 0.2, 0.3]]);
    const p = createOpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      client: fakeClient as never,
    });
    const v = await p.embed('hello world');
    expect(v).toEqual([0.1, 0.2, 0.3]);
    expect(fakeClient.embeddings.create).toHaveBeenCalledWith({
      model: 'text-embedding-3-large',
      input: 'hello world',
    });
  });

  it('embedBatch() returns one vector per input', async () => {
    const fakeClient = makeFakeClient(input => {
      const texts = Array.isArray(input) ? input : [input];
      return texts.map((_, i) => [i, i + 1, i + 2]);
    });
    const p = createOpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      client: fakeClient as never,
    });
    const vectors = await p.embedBatch(['a', 'b', 'c']);
    expect(vectors).toEqual([
      [0, 1, 2],
      [1, 2, 3],
      [2, 3, 4],
    ]);
  });

  it('embedBatch([]) short-circuits without calling OpenAI', async () => {
    const fakeClient = makeFakeClient(() => [[0]]);
    const p = createOpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      client: fakeClient as never,
    });
    const vectors = await p.embedBatch([]);
    expect(vectors).toEqual([]);
    expect(fakeClient.embeddings.create).not.toHaveBeenCalled();
  });

  it('embed() throws when OpenAI returns no vector', async () => {
    const fakeClient = {
      embeddings: {
        create: vi.fn(async () => ({ data: [] })),
      },
    };
    const p = createOpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      client: fakeClient as never,
    });
    await expect(p.embed('x')).rejects.toThrow(/missing vector/);
  });
});
