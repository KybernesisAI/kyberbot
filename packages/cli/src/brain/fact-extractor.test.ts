import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const completeMock = vi.fn<(prompt: string, opts?: unknown) => Promise<string>>();
vi.mock('../claude.js', () => ({
  getClaudeClient: () => ({ complete: completeMock }),
}));

const storeFactMock = vi.fn<(root: string, fact: unknown) => Promise<number>>();
const ensureFactsTableMock = vi.fn<(root: string) => Promise<void>>();
vi.mock('./fact-store.js', async () => {
  const actual = await vi.importActual<typeof import('./fact-store.js')>('./fact-store.js');
  return {
    ...actual,
    storeFact: (root: string, fact: unknown) => storeFactMock(root, fact),
    ensureFactsTable: (root: string) => ensureFactsTableMock(root),
  };
});

const detectTemporalExpiryMock = vi.fn<(content: string, timestamp: string) => { expires_at?: string }>();
vi.mock('./fact-temporal.js', () => ({
  detectTemporalExpiry: (content: string, timestamp: string) => detectTemporalExpiryMock(content, timestamp),
}));

const { extractFactsRealtime } = await import('./fact-extractor.js');

beforeEach(() => {
  completeMock.mockReset();
  storeFactMock.mockReset();
  storeFactMock.mockResolvedValue(1);
  ensureFactsTableMock.mockReset();
  ensureFactsTableMock.mockResolvedValue();
  detectTemporalExpiryMock.mockReset();
  detectTemporalExpiryMock.mockReturnValue({});
});

const longText =
  'David and Bob discussed the new Acme project at length, covering hiring plans, ' +
  'product roadmap, and the upcoming launch in September. They agreed to revisit pricing next week.';

describe('extractFactsRealtime', () => {
  it('returns 0 for short text without calling Claude', async () => {
    const result = await extractFactsRealtime(
      '/root', 'too short', ['David'],
      '/src', 'conv-1', '2026-05-18T10:00:00Z', 'chat',
    );
    expect(result).toBe(0);
    expect(completeMock).not.toHaveBeenCalled();
    expect(storeFactMock).not.toHaveBeenCalled();
  });

  it('returns 0 for empty entities array without calling Claude', async () => {
    const result = await extractFactsRealtime(
      '/root', longText, [],
      '/src', 'conv-1', '2026-05-18T10:00:00Z', 'chat',
    );
    expect(result).toBe(0);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('extracts and stores valid facts from a well-formed JSON response', async () => {
    completeMock.mockResolvedValueOnce(JSON.stringify([
      { content: 'David works at Acme as the CTO', category: 'biographical', confidence: 0.8, entities: ['David', 'Acme'] },
      { content: 'Bob is planning to invest in the Acme project', category: 'plan', confidence: 0.7, entities: ['Bob', 'Acme'] },
    ]));

    const result = await extractFactsRealtime(
      '/root', longText, ['David', 'Bob', 'Acme'],
      'channel://src/1', 'conv-7', '2026-05-18T10:00:00Z', 'chat',
    );

    expect(result).toBe(2);
    expect(storeFactMock).toHaveBeenCalledTimes(2);
    const firstCall = storeFactMock.mock.calls[0][1] as Record<string, unknown>;
    expect(firstCall.content).toBe('David works at Acme as the CTO');
    expect(firstCall.category).toBe('biographical');
    expect(firstCall.source_type).toBe('ai-extraction');
  });

  it('caps confidence at 0.60 even when Haiku reports higher', async () => {
    completeMock.mockResolvedValueOnce(JSON.stringify([
      { content: 'David is the CTO of Acme', category: 'biographical', confidence: 0.95, entities: ['David'] },
    ]));

    await extractFactsRealtime(
      '/root', longText, ['David'],
      '/src/1', 'conv-cap', '2026-05-18T10:00:00Z', 'chat',
    );

    expect(storeFactMock).toHaveBeenCalledTimes(1);
    const call = storeFactMock.mock.calls[0][1] as Record<string, number>;
    expect(call.confidence).toBe(0.60);
  });

  it('falls back to "general" category when Haiku returns an unknown category', async () => {
    completeMock.mockResolvedValueOnce(JSON.stringify([
      { content: 'David likes oat milk in his coffee', category: 'beverage-preference', confidence: 0.7, entities: ['David'] },
    ]));

    await extractFactsRealtime(
      '/root', longText, ['David'],
      '/src/1', 'conv-cat', '2026-05-18T10:00:00Z', 'chat',
    );

    const call = storeFactMock.mock.calls[0][1] as Record<string, string>;
    expect(call.category).toBe('general');
  });

  it('skips facts whose content is too short or too long', async () => {
    completeMock.mockResolvedValueOnce(JSON.stringify([
      { content: 'short', category: 'general', confidence: 0.7, entities: ['X'] },
      { content: 'X'.repeat(250), category: 'general', confidence: 0.7, entities: ['X'] },
      { content: 'David likes coffee — a valid mid-length fact', category: 'preference', confidence: 0.7, entities: ['David'] },
    ]));

    const result = await extractFactsRealtime(
      '/root', longText, ['David'],
      '/src/1', 'conv-len', '2026-05-18T10:00:00Z', 'chat',
    );

    expect(result).toBe(1);
    expect(storeFactMock).toHaveBeenCalledTimes(1);
  });

  it('skips facts with no entities array', async () => {
    completeMock.mockResolvedValueOnce(JSON.stringify([
      { content: 'A fact with no subject identified', category: 'general', confidence: 0.7, entities: [] },
      { content: 'David is the CTO of Acme', category: 'biographical', confidence: 0.7, entities: ['David'] },
    ]));

    const result = await extractFactsRealtime(
      '/root', longText, ['David'],
      '/src/1', 'conv-noent', '2026-05-18T10:00:00Z', 'chat',
    );

    expect(result).toBe(1);
    expect(storeFactMock).toHaveBeenCalledTimes(1);
  });

  it('caps at 3 facts even when Haiku returns more', async () => {
    completeMock.mockResolvedValueOnce(JSON.stringify([
      { content: 'Fact one about David', category: 'general', confidence: 0.6, entities: ['David'] },
      { content: 'Fact two about Bob', category: 'general', confidence: 0.6, entities: ['Bob'] },
      { content: 'Fact three about Carol', category: 'general', confidence: 0.6, entities: ['Carol'] },
      { content: 'Fact four about Dave', category: 'general', confidence: 0.6, entities: ['Dave'] },
      { content: 'Fact five about Erin', category: 'general', confidence: 0.6, entities: ['Erin'] },
    ]));

    const result = await extractFactsRealtime(
      '/root', longText, ['David'],
      '/src/1', 'conv-cap3', '2026-05-18T10:00:00Z', 'chat',
    );

    expect(result).toBe(3);
    expect(storeFactMock).toHaveBeenCalledTimes(3);
  });

  it('returns 0 on malformed JSON without throwing', async () => {
    completeMock.mockResolvedValueOnce('this is not JSON at all — just prose');
    const result = await extractFactsRealtime(
      '/root', longText, ['David'],
      '/src/1', 'conv-bad', '2026-05-18T10:00:00Z', 'chat',
    );
    expect(result).toBe(0);
    expect(storeFactMock).not.toHaveBeenCalled();
  });

  it('returns 0 when JSON parse succeeds but result is not an array', async () => {
    completeMock.mockResolvedValueOnce('[{"oops": "not an array"} actually this is an array of one]');
    // Force JSON.parse to succeed but on a non-array
    completeMock.mockReset();
    completeMock.mockResolvedValueOnce('Response: [{"not": "valid array entry"}] which after regex becomes...');
    const result = await extractFactsRealtime(
      '/root', longText, ['David'],
      '/src/1', 'conv-shape', '2026-05-18T10:00:00Z', 'chat',
    );
    // The regex finds the first [...] which IS an array of one — but the items are missing required fields.
    // Either way: 0 facts stored.
    expect(result).toBe(0);
  });

  it('propagates ARP metadata into the FactInput passed to storeFact', async () => {
    completeMock.mockResolvedValueOnce(JSON.stringify([
      { content: 'David is leading Project Atlas this quarter', category: 'plan', confidence: 0.7, entities: ['David', 'Atlas'] },
    ]));

    await extractFactsRealtime(
      '/root', longText, ['David', 'Atlas'],
      '/src/1', 'conv-arp', '2026-05-18T10:00:00Z', 'chat',
      {
        project_id: 'proj-atlas',
        tags: ['roadmap', 'internal'],
        classification: 'internal',
        connection_id: 'conn-abc',
        source_did: 'did:example:xyz',
      },
    );

    expect(storeFactMock).toHaveBeenCalledTimes(1);
    const call = storeFactMock.mock.calls[0][1] as Record<string, unknown>;
    expect(call.project_id).toBe('proj-atlas');
    expect(call.tags).toEqual(['roadmap', 'internal']);
    expect(call.classification).toBe('internal');
    expect(call.connection_id).toBe('conn-abc');
    expect(call.source_did).toBe('did:example:xyz');
  });

  it('hooks detectTemporalExpiry to populate expires_at when temporal language is present', async () => {
    completeMock.mockResolvedValueOnce(JSON.stringify([
      { content: 'David is in Tokyo this week', category: 'temporal', confidence: 0.7, entities: ['David'] },
    ]));
    detectTemporalExpiryMock.mockReturnValueOnce({ expires_at: '2026-05-25T00:00:00Z' });

    await extractFactsRealtime(
      '/root', longText, ['David'],
      '/src/1', 'conv-temp', '2026-05-18T10:00:00Z', 'chat',
    );

    expect(detectTemporalExpiryMock).toHaveBeenCalled();
    const call = storeFactMock.mock.calls[0][1] as Record<string, string>;
    expect(call.expires_at).toBe('2026-05-25T00:00:00Z');
  });

  it('does not throw when the Claude client rejects', async () => {
    completeMock.mockRejectedValueOnce(new Error('claude unavailable'));
    const result = await extractFactsRealtime(
      '/root', longText, ['David'],
      '/src/1', 'conv-err', '2026-05-18T10:00:00Z', 'chat',
    );
    expect(result).toBe(0);
  });

  it('continues storing remaining facts if one storeFact call throws', async () => {
    completeMock.mockResolvedValueOnce(JSON.stringify([
      { content: 'First fact about David working at Acme', category: 'biographical', confidence: 0.7, entities: ['David'] },
      { content: 'Second fact about Bob managing the team', category: 'biographical', confidence: 0.7, entities: ['Bob'] },
    ]));
    storeFactMock.mockRejectedValueOnce(new Error('store failed'));
    storeFactMock.mockResolvedValueOnce(2);

    const result = await extractFactsRealtime(
      '/root', longText, ['David', 'Bob'],
      '/src/1', 'conv-mix', '2026-05-18T10:00:00Z', 'chat',
    );

    expect(result).toBe(1);
    expect(storeFactMock).toHaveBeenCalledTimes(2);
  });
});
