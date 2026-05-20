import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Wrap the real sqlite-vec factory in a vi.fn so individual tests can override
// it for the failure path (UT-007 / EC-004). Default behaviour is the real impl.
vi.mock('@kybernesis/arcana-provider-sqlite-vec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kybernesis/arcana-provider-sqlite-vec')>();
  return {
    ...actual,
    createSqliteVecVectorStore: vi.fn(actual.createSqliteVecVectorStore),
  };
});

import { bootArcana } from './boot-arcana.js';
import { getArcanaInstance, resetArcanaForTests } from './arcana-singleton.js';

describe('bootArcana', () => {
  let root: string;
  const prevKey = process.env.OPENAI_API_KEY;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kyberbot-boot-arcana-'));
    resetArcanaForTests();
  });

  afterEach(async () => {
    resetArcanaForTests();
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
    await rm(root, { recursive: true, force: true });
  });

  it('returns a disabled handle when OPENAI_API_KEY is unset and does not init Arcana', async () => {
    delete process.env.OPENAI_API_KEY;
    const handle = await bootArcana(root);
    expect(handle.status()).toBe('disabled');
    expect(getArcanaInstance()).toBeNull();
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it('treats a whitespace-only OPENAI_API_KEY as unset (EC-013)', async () => {
    process.env.OPENAI_API_KEY = '   ';
    const handle = await bootArcana(root);
    expect(handle.status()).toBe('disabled');
    expect(getArcanaInstance()).toBeNull();
  });

  it('boots Arcana and passes vector: undefined when the vector store fails to connect (UT-007 / EC-004)', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-bootarcana';
    // Force the degradation path deterministically — override the mocked
    // factory for this single call.
    const vecMod = await import('@kybernesis/arcana-provider-sqlite-vec');
    vi.mocked(vecMod.createSqliteVecVectorStore).mockReturnValueOnce({
      connect: vi.fn().mockRejectedValue(new Error('mocked: sqlite-vec unreachable')),
      disconnect: vi.fn(),
      upsert: vi.fn(),
      query: vi.fn(),
      delete: vi.fn(),
    });

    const handle = await bootArcana(root);
    expect(handle.status()).toBe('running');
    const arcana = getArcanaInstance();
    expect(arcana).not.toBeNull();
    expect(arcana?.providers.vector).toBeUndefined();
    expect(arcana?.providers.structured).toBeDefined();
    await handle.stop();
    expect(getArcanaInstance()).toBeNull();
  });

  it('serialises concurrent initArcana calls (EC-015 — fleet-mode race)', async () => {
    const { initArcana } = await import('./arcana-singleton.js');
    const { createFakeStructuredStore } = await import('@kybernesis/arcana-testkit');
    const { createFakeVectorStore } = await import('@kybernesis/arcana-testkit');
    const { createFakeEmbeddingProvider } = await import('@kybernesis/arcana-testkit');
    const { createFakeLLMProvider } = await import('@kybernesis/arcana-testkit');

    const structured = createFakeStructuredStore();
    await structured.connect();

    // Fire two init calls before the first resolves. With the in-flight guard
    // they must both resolve to the same instance; without it, the second call
    // would dispose the first's providers mid-flight and produce a fresh one.
    const opts = { structured, vector: createFakeVectorStore(), embed: createFakeEmbeddingProvider(), llm: createFakeLLMProvider() };
    const [a, b] = await Promise.all([initArcana(opts), initArcana(opts)]);
    expect(a).toBe(b);
    expect(getArcanaInstance()).toBe(a);
  });

  it('stop() disposes the singleton even on repeat invocation', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-bootarcana';
    const handle = await bootArcana(root);
    await handle.stop();
    expect(getArcanaInstance()).toBeNull();
    // Second stop is a no-op (providers cleared)
    await expect(handle.stop()).resolves.toBeUndefined();
  });
});
