import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const completeMock = vi.fn<(prompt: string, opts?: unknown) => Promise<string>>();
vi.mock('../claude.js', () => ({
  getClaudeClient: () => ({ complete: completeMock }),
}));

const getFactsForEntityMock = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();
vi.mock('./fact-store.js', async () => {
  const actual = await vi.importActual<typeof import('./fact-store.js')>('./fact-store.js');
  return {
    ...actual,
    getFactsForEntity: (...args: unknown[]) => getFactsForEntityMock(...args),
  };
});

const { detectContradictions } = await import('./fact-contradiction.js');

interface FakeFact {
  id: number;
  content: string;
  category: string;
  confidence: number;
}

function fact(id: number, content: string, category: string = 'biographical'): FakeFact {
  return { id, content, category, confidence: 0.7 };
}

beforeEach(() => {
  completeMock.mockReset();
  getFactsForEntityMock.mockReset();
  getFactsForEntityMock.mockResolvedValue([]);
});

describe('detectContradictions', () => {
  it('short-circuits when newFact.entities is empty (no Haiku call)', async () => {
    const result = await detectContradictions('/root', {
      content: 'A claim with no subject',
      entities: [],
      category: 'general',
    });
    expect(result).toEqual({ contradictions: [], checked: 0 });
    expect(completeMock).not.toHaveBeenCalled();
    expect(getFactsForEntityMock).not.toHaveBeenCalled();
  });

  it('returns early with no Haiku call when there are no related-category candidates', async () => {
    getFactsForEntityMock.mockResolvedValueOnce([
      fact(1, 'Alice likes coffee', 'preference'),
    ]);

    const result = await detectContradictions('/root', {
      content: 'Alice graduated in 2018',
      entities: ['Alice'],
      category: 'biographical',
    });

    expect(result.contradictions).toEqual([]);
    expect(result.checked).toBe(0);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('filters candidates by related-category — biographical only matches biographical', async () => {
    getFactsForEntityMock.mockResolvedValueOnce([
      fact(1, 'Alice works at Acme', 'biographical'),
      fact(2, 'Alice likes coffee', 'preference'),
      fact(3, 'Alice presented at the conference', 'event'),
    ]);
    completeMock.mockResolvedValueOnce('[]');

    await detectContradictions('/root', {
      content: 'Alice works at Globex',
      entities: ['Alice'],
      category: 'biographical',
    });

    expect(completeMock).toHaveBeenCalledTimes(1);
    const prompt = completeMock.mock.calls[0][0] as string;
    expect(prompt).toContain('"Alice works at Acme"');
    expect(prompt).not.toContain('Alice likes coffee');
    expect(prompt).not.toContain('Alice presented at the conference');
  });

  it("'general' category matches all related-category buckets", async () => {
    getFactsForEntityMock.mockResolvedValueOnce([
      fact(1, 'fact bio', 'biographical'),
      fact(2, 'fact pref', 'preference'),
      fact(3, 'fact event', 'event'),
      fact(4, 'fact rel', 'relationship'),
    ]);
    completeMock.mockResolvedValueOnce('[]');

    await detectContradictions('/root', {
      content: 'a general claim',
      entities: ['X'],
      category: 'general',
    });

    expect(completeMock).toHaveBeenCalledTimes(1);
    const prompt = completeMock.mock.calls[0][0] as string;
    expect(prompt).toContain('fact bio');
    expect(prompt).toContain('fact pref');
    expect(prompt).toContain('fact event');
    expect(prompt).toContain('fact rel');
  });

  it('caps the candidate list passed to Haiku at 10 even when more match', async () => {
    const many: FakeFact[] = Array.from({ length: 25 }, (_, i) => fact(i + 1, `fact #${i + 1}`));
    getFactsForEntityMock.mockResolvedValueOnce(many);
    completeMock.mockResolvedValueOnce('[]');

    const result = await detectContradictions('/root', {
      content: 'a new fact',
      entities: ['X'],
      category: 'biographical',
    });

    expect(result.checked).toBe(10);
    const prompt = completeMock.mock.calls[0][0] as string;
    expect(prompt).toContain('fact #1');
    expect(prompt).toContain('fact #10');
    expect(prompt).not.toContain('fact #11');
  });

  it('returns valid contradictions from a well-formed Haiku response', async () => {
    getFactsForEntityMock.mockResolvedValueOnce([
      fact(7, 'Alice works at Acme', 'biographical'),
      fact(8, 'Alice lives in NYC', 'biographical'),
    ]);
    completeMock.mockResolvedValueOnce(JSON.stringify([
      { id: 7, relationship: 'updates', rationale: 'employer changed' },
      { id: 8, relationship: 'extends', rationale: 'narrowed location to Brooklyn' },
    ]));

    const result = await detectContradictions('/root', {
      content: 'Alice now works at Globex and moved to Brooklyn',
      entities: ['Alice'],
      category: 'biographical',
    });

    expect(result.contradictions).toEqual([
      { oldFactId: 7, relationship: 'updates', rationale: 'employer changed' },
      { oldFactId: 8, relationship: 'extends', rationale: 'narrowed location to Brooklyn' },
    ]);
    expect(result.checked).toBe(2);
  });

  it('drops Haiku results whose id is not in the candidate set (hallucination guard)', async () => {
    getFactsForEntityMock.mockResolvedValueOnce([fact(7, 'real fact', 'biographical')]);
    completeMock.mockResolvedValueOnce(JSON.stringify([
      { id: 7, relationship: 'updates', rationale: 'legit' },
      { id: 99999, relationship: 'updates', rationale: 'hallucinated id' },
    ]));

    const result = await detectContradictions('/root', {
      content: 'a new fact',
      entities: ['X'],
      category: 'biographical',
    });

    expect(result.contradictions).toEqual([
      { oldFactId: 7, relationship: 'updates', rationale: 'legit' },
    ]);
  });

  it('drops Haiku results with unknown relationship values', async () => {
    getFactsForEntityMock.mockResolvedValueOnce([
      fact(7, 'fact a', 'biographical'),
      fact(8, 'fact b', 'biographical'),
      fact(9, 'fact c', 'biographical'),
    ]);
    completeMock.mockResolvedValueOnce(JSON.stringify([
      { id: 7, relationship: 'none', rationale: 'no relation' },
      { id: 8, relationship: 'contradicts', rationale: 'unrecognised vocab' },
      { id: 9, relationship: 'updates', rationale: 'valid' },
    ]));

    const result = await detectContradictions('/root', {
      content: 'a new fact',
      entities: ['X'],
      category: 'biographical',
    });

    expect(result.contradictions).toEqual([
      { oldFactId: 9, relationship: 'updates', rationale: 'valid' },
    ]);
  });

  it('returns empty contradictions when Haiku produces malformed JSON', async () => {
    getFactsForEntityMock.mockResolvedValueOnce([fact(7, 'a fact', 'biographical')]);
    completeMock.mockResolvedValueOnce('this is not JSON at all — just prose');

    const result = await detectContradictions('/root', {
      content: 'a new fact',
      entities: ['X'],
      category: 'biographical',
    });

    expect(result.contradictions).toEqual([]);
    expect(result.checked).toBe(1);
  });

  it('returns empty contradictions when Haiku returns a non-array shape', async () => {
    getFactsForEntityMock.mockResolvedValueOnce([fact(7, 'a fact', 'biographical')]);
    // Regex finds the first [...] inside the response; a [{ ... }] string IS an array,
    // but a [...] with garbage inside fails JSON.parse and short-circuits to [].
    completeMock.mockResolvedValueOnce('Result: [not valid json inside brackets at all]');

    const result = await detectContradictions('/root', {
      content: 'a new fact',
      entities: ['X'],
      category: 'biographical',
    });

    expect(result.contradictions).toEqual([]);
  });

  it('swallows Haiku errors and returns empty contradictions', async () => {
    getFactsForEntityMock.mockResolvedValueOnce([fact(7, 'a fact', 'biographical')]);
    completeMock.mockRejectedValueOnce(new Error('claude unavailable'));

    const result = await detectContradictions('/root', {
      content: 'a new fact',
      entities: ['X'],
      category: 'biographical',
    });

    expect(result.contradictions).toEqual([]);
    expect(result.checked).toBe(1);
  });

  it('deduplicates candidates across multiple entities', async () => {
    const shared = fact(42, 'a fact mentioning both', 'biographical');
    getFactsForEntityMock
      .mockResolvedValueOnce([shared, fact(43, 'alice-only', 'biographical')])
      .mockResolvedValueOnce([shared, fact(44, 'bob-only', 'biographical')]);
    completeMock.mockResolvedValueOnce('[]');

    const result = await detectContradictions('/root', {
      content: 'a claim about both alice and bob',
      entities: ['Alice', 'Bob'],
      category: 'biographical',
    });

    // 3 unique candidates (42, 43, 44) — not 4 (which would imply duplicate fact #42)
    expect(result.checked).toBe(3);
    const prompt = completeMock.mock.calls[0][0] as string;
    const occurrences = (prompt.match(/a fact mentioning both/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('tolerates per-entity getFactsForEntity failures and continues', async () => {
    getFactsForEntityMock
      .mockRejectedValueOnce(new Error('db hiccup for alice'))
      .mockResolvedValueOnce([fact(50, 'bob-fact', 'biographical')]);
    completeMock.mockResolvedValueOnce('[]');

    const result = await detectContradictions('/root', {
      content: 'something',
      entities: ['Alice', 'Bob'],
      category: 'biographical',
    });

    expect(result.checked).toBe(1);
    const prompt = completeMock.mock.calls[0][0] as string;
    expect(prompt).toContain('bob-fact');
  });
});
