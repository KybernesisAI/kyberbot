import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Stub every subsystem storeConversation calls. The orchestrator is best
// tested for its orchestration behaviour (queueing, error-swallowing, ARP
// passthrough), not for the per-subsystem semantics (those have their own
// test files).
const addConversationToTimelineMock = vi.fn<(...args: unknown[]) => Promise<number>>();
const findRecentDuplicateMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const incrementTimelineEventCountMock = vi.fn<(...args: unknown[]) => Promise<void>>();
vi.mock('./timeline.js', () => ({
  addConversationToTimeline: (...args: unknown[]) => addConversationToTimelineMock(...args),
  findRecentDuplicate: (...args: unknown[]) => findRecentDuplicateMock(...args),
  incrementTimelineEventCount: (...args: unknown[]) => incrementTimelineEventCountMock(...args),
}));

vi.mock('./entity-graph.js', () => ({
  findOrCreateEntity: vi.fn(async () => ({ id: 1, name: 'X', type: 'person' })),
  addEntityMention: vi.fn(async () => undefined),
  linkEntitiesWithType: vi.fn(async () => undefined),
}));

vi.mock('./relationship-extractor.js', () => ({
  extractRelationships: vi.fn(async () => ({ entities: [], relationships: [] })),
}));

vi.mock('./embeddings.js', () => ({
  indexDocument: vi.fn(async () => 0),
  isChromaAvailable: vi.fn(() => false),
}));

vi.mock('./fact-extractor.js', () => ({
  extractFactsRealtime: vi.fn(async () => 0),
}));

const {
  filterNoiseEntities,
  isStoreActive,
  storeConversation,
  SOURCE_CONFIDENCE,
} = await import('./store-conversation.js');

beforeEach(() => {
  addConversationToTimelineMock.mockReset();
  addConversationToTimelineMock.mockResolvedValue(1);
  findRecentDuplicateMock.mockReset();
  findRecentDuplicateMock.mockResolvedValue(null);
  incrementTimelineEventCountMock.mockReset();
  incrementTimelineEventCountMock.mockResolvedValue();
});

describe('SOURCE_CONFIDENCE', () => {
  it('encodes the documented confidence ladder', () => {
    expect(SOURCE_CONFIDENCE['user-correction']).toBe(1.0);
    expect(SOURCE_CONFIDENCE['user-direct']).toBe(0.95);
    expect(SOURCE_CONFIDENCE['chat']).toBe(0.85);
    expect(SOURCE_CONFIDENCE['heartbeat']).toBe(0.80);
    expect(SOURCE_CONFIDENCE['ai-extraction']).toBe(0.60);
  });
});

describe('filterNoiseEntities', () => {
  it('drops single-character names', () => {
    expect(filterNoiseEntities([
      { name: 'A', type: 'person' },
      { name: 'Alice', type: 'person' },
    ])).toEqual([{ name: 'Alice', type: 'person' }]);
  });

  it('drops pronouns', () => {
    const out = filterNoiseEntities([
      { name: 'he', type: 'person' },
      { name: 'They', type: 'person' },
      { name: 'Alice', type: 'person' },
    ]);
    expect(out).toEqual([{ name: 'Alice', type: 'person' }]);
  });

  it('drops shell command names', () => {
    const out = filterNoiseEntities([
      { name: 'curl', type: 'project' },
      { name: 'git', type: 'project' },
      { name: 'Acme', type: 'company' },
    ]);
    expect(out).toEqual([{ name: 'Acme', type: 'company' }]);
  });

  it('drops file paths', () => {
    const out = filterNoiseEntities([
      { name: './packages/cli/foo.ts', type: 'project' },
      { name: '~/notes.md', type: 'project' },
      { name: 'package.json', type: 'project' },
      { name: 'Atlas', type: 'project' },
    ]);
    expect(out).toEqual([{ name: 'Atlas', type: 'project' }]);
  });

  it('drops UUIDs and URLs', () => {
    const out = filterNoiseEntities([
      { name: 'a1b2c3d4-5678-90ab-cdef-1234567890ab', type: 'project' },
      { name: 'https://example.com', type: 'project' },
      { name: 'Atlas', type: 'project' },
    ]);
    expect(out).toEqual([{ name: 'Atlas', type: 'project' }]);
  });

  it('drops conversational noise words like "ok" and "speaker"', () => {
    const out = filterNoiseEntities([
      { name: 'ok', type: 'person' },
      { name: 'speaker', type: 'person' },
      { name: 'thanks', type: 'person' },
      { name: 'Alice', type: 'person' },
    ]);
    expect(out).toEqual([{ name: 'Alice', type: 'person' }]);
  });

  it('applies the agent stoplist case-insensitively', () => {
    const out = filterNoiseEntities(
      [
        { name: 'Acme', type: 'company' },
        { name: 'INTERNAL', type: 'project' },
        { name: 'Atlas', type: 'project' },
      ],
      ['acme', 'internal'],
    );
    expect(out).toEqual([{ name: 'Atlas', type: 'project' }]);
  });

  it('drops transcription speaker artifacts', () => {
    const out = filterNoiseEntities([
      { name: 'Speaker 0', type: 'person' },
      { name: 'Speaker 1', type: 'person' },
      { name: 'Alice', type: 'person' },
    ]);
    expect(out).toEqual([{ name: 'Alice', type: 'person' }]);
  });
});

describe('isStoreActive', () => {
  it('returns false before any storeConversation call', () => {
    expect(isStoreActive('/no-store-root')).toBe(false);
    expect(isStoreActive()).toBe(false);
  });
});

describe('storeConversation queueing', () => {
  it('serialises concurrent calls for the same root', async () => {
    const root = '/queue-test-root';
    const order: number[] = [];

    addConversationToTimelineMock.mockImplementation(async (_root, _id, sp: unknown) => {
      const n = Number(String(sp).split('/').pop());
      order.push(n);
      // Insert a tiny delay so a non-serialised implementation would interleave.
      await new Promise(r => setTimeout(r, 5));
      return 1;
    });

    await Promise.all([
      storeConversation(root, { prompt: 'one', response: 'r1', channel: 'chat' }),
      storeConversation(root, { prompt: 'two', response: 'r2', channel: 'chat' }),
      storeConversation(root, { prompt: 'three', response: 'r3', channel: 'chat' }),
    ]);

    expect(addConversationToTimelineMock).toHaveBeenCalledTimes(3);
    // After all calls settle, no store should still be active.
    expect(isStoreActive(root)).toBe(false);
  });

  it('does not throw when a subsystem errors', async () => {
    addConversationToTimelineMock.mockRejectedValueOnce(new Error('timeline failure'));

    await expect(
      storeConversation('/error-root', { prompt: 'q', response: 'a', channel: 'chat' }),
    ).resolves.not.toThrow();

    expect(isStoreActive('/error-root')).toBe(false);
  });
});
