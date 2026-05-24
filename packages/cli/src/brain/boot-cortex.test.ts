import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Wrap the real sqlite-vec factory in a vi.fn so individual tests can override
// it for the failure path (UT-007 / EC-004). Default behaviour is the real impl.
vi.mock('@kybernesis/cortex-provider-sqlite-vec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kybernesis/cortex-provider-sqlite-vec')>();
  return {
    ...actual,
    createSqliteVecVectorStore: vi.fn(actual.createSqliteVecVectorStore),
  };
});

import { bootCortex } from './boot-cortex.js';
import { getCortexInstance, resetCortexForTests } from './cortex-singleton.js';

describe('bootCortex', () => {
  let root: string;
  const prevKey = process.env.OPENAI_API_KEY;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kyberbot-boot-arcana-'));
    resetCortexForTests();
  });

  afterEach(async () => {
    resetCortexForTests();
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
    await rm(root, { recursive: true, force: true });
  });

  it('returns a disabled handle when OPENAI_API_KEY is unset and does not init Arcana', async () => {
    delete process.env.OPENAI_API_KEY;
    const handle = await bootCortex(root);
    expect(handle.status()).toBe('disabled');
    expect(getCortexInstance()).toBeNull();
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it('treats a whitespace-only OPENAI_API_KEY as unset (EC-013)', async () => {
    process.env.OPENAI_API_KEY = '   ';
    const handle = await bootCortex(root);
    expect(handle.status()).toBe('disabled');
    expect(getCortexInstance()).toBeNull();
  });

  it('boots Arcana and passes vector: undefined when the vector store fails to connect (UT-007 / EC-004)', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-bootarcana';
    // Force the degradation path deterministically — override the mocked
    // factory for this single call.
    const vecMod = await import('@kybernesis/cortex-provider-sqlite-vec');
    vi.mocked(vecMod.createSqliteVecVectorStore).mockReturnValueOnce({
      connect: vi.fn().mockRejectedValue(new Error('mocked: sqlite-vec unreachable')),
      disconnect: vi.fn(),
      upsert: vi.fn(),
      query: vi.fn(),
      delete: vi.fn(),
    });

    const handle = await bootCortex(root);
    expect(handle.status()).toBe('running');
    const arcana = getCortexInstance();
    expect(arcana).not.toBeNull();
    expect(arcana?.providers.vector).toBeUndefined();
    expect(arcana?.providers.structured).toBeDefined();
    await handle.stop();
    expect(getCortexInstance()).toBeNull();
  });

  it('serialises concurrent initCortex calls (EC-015 — fleet-mode race)', async () => {
    const { initCortex } = await import('./cortex-singleton.js');
    const { createFakeStructuredStore } = await import('@kybernesis/cortex-testkit');
    const { createFakeVectorStore } = await import('@kybernesis/cortex-testkit');
    const { createFakeEmbeddingProvider } = await import('@kybernesis/cortex-testkit');
    const { createFakeLLMProvider } = await import('@kybernesis/cortex-testkit');

    const structured = createFakeStructuredStore();
    await structured.connect();

    // Fire two init calls before the first resolves. With the in-flight guard
    // they must both resolve to the same instance; without it, the second call
    // would dispose the first's providers mid-flight and produce a fresh one.
    const opts = { structured, vector: createFakeVectorStore(), embed: createFakeEmbeddingProvider(), llm: createFakeLLMProvider() };
    const [a, b] = await Promise.all([initCortex(opts), initCortex(opts)]);
    expect(a).toBe(b);
    expect(getCortexInstance()).toBe(a);
  });

  it('stop() disposes the singleton even on repeat invocation', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-bootarcana';
    const handle = await bootCortex(root);
    await handle.stop();
    expect(getCortexInstance()).toBeNull();
    // Second stop is a no-op (providers cleared)
    await expect(handle.stop()).resolves.toBeUndefined();
  });
});
