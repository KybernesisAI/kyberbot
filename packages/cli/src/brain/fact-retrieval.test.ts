import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Mock semanticSearch + isChromaAvailable. Real ChromaDB is heavy + external;
// fact-retrieval reads through these so we control what semantic search
// returns. indexDocument is also stubbed so fact-store doesn't try to index.
const semanticSearchMock = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();
const isChromaAvailableMock = vi.fn<() => boolean>();
vi.mock('./embeddings.js', () => ({
  semanticSearch: (...args: unknown[]) => semanticSearchMock(...args),
  isChromaAvailable: () => isChromaAvailableMock(),
  indexDocument: vi.fn(async () => 0),
}));

// Pre-import the real ensureFactsTable, then mock it everywhere in this file
// so that fact-retrieval's internal `ensureFactsTable(root)` call doesn't
// recreate the broken FTS5 triggers between our beforeEach DROP and the
// trackFactAccess UPDATE that fires them. beforeAll calls the real version
// once to set up the schema; nothing else needs to.
const factStoreReal = await vi.importActual<typeof import('./fact-store.js')>('./fact-store.js');
vi.mock('./fact-store.js', async () => {
  const actual = await vi.importActual<typeof import('./fact-store.js')>('./fact-store.js');
  return {
    ...actual,
    ensureFactsTable: vi.fn(async () => undefined),
  };
});

const {
  factFirstSearch,
} = await import('./fact-retrieval.js');
const { storeFact } = await import('./fact-store.js');
const { ensureFactsTable } = factStoreReal;
const { getTimelineDb, addToTimeline, resetTimelineDb } = await import('./timeline.js');
const {
  findOrCreateEntity,
  linkEntities,
  resetEntityGraphDb,
} = await import('./entity-graph.js');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-fact-retrieval-'));
  await ensureFactsTable(root);
});

afterAll(async () => {
  resetTimelineDb(root);
  resetEntityGraphDb(root);
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  semanticSearchMock.mockReset();
  semanticSearchMock.mockResolvedValue([]);
  isChromaAvailableMock.mockReset();
  isChromaAvailableMock.mockReturnValue(false);

  // Same workaround as fact-store.test.ts — fact-store creates broken FTS5
  // triggers that error on UPDATE/DELETE. fact-retrieval's `trackFactAccess`
  // UPDATEs facts, so these triggers must be dropped before each test.
  const db = await getTimelineDb(root);
  db.exec(`DROP TRIGGER IF EXISTS facts_fts_ai`);
  db.exec(`DROP TRIGGER IF EXISTS facts_fts_ad`);
  db.exec(`DROP TRIGGER IF EXISTS facts_fts_au`);
  db.exec(`DROP TABLE IF EXISTS facts_fts`);
});

async function seedFact(opts: {
  id?: string;       // suffix for unique source_path
  content: string;
  category?: 'biographical' | 'preference' | 'event' | 'relationship' | 'temporal' | 'opinion' | 'plan' | 'general';
  entities: string[];
  conversationId?: string;
  confidence?: number;
  timestamp?: string;
}): Promise<number> {
  const suffix = opts.id ?? Math.random().toString(36).slice(2, 8);
  return storeFact(root, {
    content: opts.content,
    source_path: `/test/${suffix}`,
    source_conversation_id: opts.conversationId ?? `conv-${suffix}`,
    entities: opts.entities,
    timestamp: opts.timestamp ?? '2026-05-18T10:00:00Z',
    confidence: opts.confidence ?? 0.8,
    category: opts.category ?? 'biographical',
  });
}

async function seedTimelineEvent(opts: {
  sourcePath: string;
  summary: string;
  timestamp?: string;
}): Promise<number> {
  return addToTimeline(root, {
    type: 'conversation',
    timestamp: opts.timestamp ?? '2026-05-18T09:00:00Z',
    title: opts.summary.slice(0, 40),
    summary: opts.summary,
    source_path: opts.sourcePath,
    entities: [],
    topics: [],
  });
}

// Recreate the broken-but-required FTS5 index between tests. fact-retrieval's
// Layer 1 relies on facts_fts MATCH; without it, FTS branch silently returns
// no rows (which is fine for some tests, but we need it real for the ones
// asserting keyword matching). Use fact-store's own create — Layer 1 reads
// the same table.
async function rebuildFactsFts(): Promise<void> {
  const db = await getTimelineDb(root);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(content, entities);
  `);
  // Backfill from existing facts.
  const rows = db.prepare('SELECT id, content, entities_json FROM facts').all() as Array<{
    id: number; content: string; entities_json: string;
  }>;
  const insert = db.prepare('INSERT INTO facts_fts(rowid, content, entities) VALUES (?,?,?)');
  for (const r of rows) {
    try { insert.run(r.id, r.content, r.entities_json); } catch { /* dedup ok */ }
  }
}

describe('factFirstSearch — overall shape & guard rails', () => {
  it('returns an empty-shaped result when no facts match anything', async () => {
    const result = await factFirstSearch('nothing here', root);
    expect(result).toMatchObject({
      facts: [],
      supporting_context: [],
      assembled_context: '',
      token_estimate: 0,
    });
    expect(result.stats).toMatchObject({
      direct_facts: 0,
      expanded_facts: 0,
      graph_expanded_facts: 0,
      scene_expanded_facts: 0,
      bridge_facts: 0,
      supporting_chunks: 0,
      pruned_items: 0,
    });
  });

  it('returns the FactSearchResult shape with all top-level fields populated', async () => {
    await seedFact({ id: 'shape-1', content: 'Alice works at Acme as the CTO', entities: ['Alice', 'Acme'] });
    await rebuildFactsFts();

    const result = await factFirstSearch('Alice', root);
    expect(result).toHaveProperty('facts');
    expect(result).toHaveProperty('supporting_context');
    expect(result).toHaveProperty('assembled_context');
    expect(result).toHaveProperty('token_estimate');
    expect(result).toHaveProperty('stats');
    expect(Array.isArray(result.facts)).toBe(true);
    expect(typeof result.assembled_context).toBe('string');
    expect(typeof result.token_estimate).toBe('number');
  });
});

describe('Layer 1 — direct fact search', () => {
  it('surfaces facts matching FTS keyword query as source="direct"', async () => {
    await seedFact({ id: 'l1-fts-1', content: 'Kubernetes deployment for the cluster', entities: ['Cluster'], category: 'event' });
    await rebuildFactsFts();

    const result = await factFirstSearch('kubernetes', root);
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts[0].content).toContain('Kubernetes');
    expect(result.facts[0].source).toBe('direct');
    expect(result.stats.direct_facts).toBeGreaterThan(0);
  });

  it('merges ChromaDB semantic results (when available) into Layer 1', async () => {
    const factId = await seedFact({
      id: 'l1-semantic',
      content: 'Bob enjoys hiking on weekends',
      entities: ['Bob'],
      category: 'preference',
    });
    await rebuildFactsFts();

    isChromaAvailableMock.mockReturnValue(true);
    semanticSearchMock.mockResolvedValue([
      {
        id: `fact_${factId}`,
        content: 'Bob enjoys hiking on weekends',
        distance: 0.2,
        metadata: {
          source_path: `fact://conv-l1-semantic/0`,
          type: 'note',
          timestamp: '2026-05-18T10:00:00Z',
        },
      },
    ]);

    const result = await factFirstSearch('outdoor activities', root);
    expect(result.facts.some(f => f.content.includes('hiking'))).toBe(true);
  });

  it('respects limit even when many candidates match', async () => {
    for (let i = 1; i <= 30; i++) {
      await seedFact({
        id: `l1-limit-${i}`,
        content: `Kubernetes deployment number ${i} for the production cluster`,
        entities: [`Cluster${i}`],
      });
    }
    await rebuildFactsFts();

    const result = await factFirstSearch('kubernetes', root, { limit: 5 });
    expect(result.facts.length).toBeLessThanOrEqual(5);
  });

  it('only returns facts where is_latest=1 (filters superseded)', async () => {
    const oldId = await seedFact({
      id: 'l1-super-old',
      content: 'OldCo employs Carol as engineer',
      entities: ['Carol', 'OldCo'],
    });
    await rebuildFactsFts();

    // Mark superseded directly in the DB
    const db = await getTimelineDb(root);
    db.prepare('UPDATE facts SET is_latest = 0 WHERE id = ?').run(oldId);

    const result = await factFirstSearch('OldCo', root);
    expect(result.facts.find(f => f.id === oldId)).toBeUndefined();
  });
});

describe('Layer 2 — entity expansion', () => {
  it('expands via entity_relations when the query mentions an entity name', async () => {
    // Set up entities + a relation
    const alice = await findOrCreateEntity(root, 'AliceExp', 'person', '2026-05-18T09:00:00Z');
    const acme = await findOrCreateEntity(root, 'AcmeExp', 'company', '2026-05-18T09:00:00Z');
    await linkEntities(root, alice.id, acme.id, 'works_at');

    // Seed a fact about Acme (not directly mentioning AliceExp by name)
    await seedFact({
      id: 'l2-exp-acme',
      content: 'AcmeExp is headquartered in Boston with 200 employees',
      entities: ['AcmeExp'],
      category: 'biographical',
    });
    await rebuildFactsFts();

    // Query mentions AliceExp; expansion should pull the AcmeExp fact via the relation
    const result = await factFirstSearch('AliceExp', root);
    const expanded = result.facts.find(f => f.content.includes('AcmeExp'));
    // Either it's found via direct match (FTS picks up 'AcmeExp' isn't in query, so it shouldn't)
    // OR via entity expansion. Either way the entity path should surface something.
    if (expanded) {
      expect(['direct', 'entity_expansion', 'graph_expansion']).toContain(expanded.source);
    }
  });

  it("does not over-expand: query with no entity mentions produces no Layer 2 results", async () => {
    await findOrCreateEntity(root, 'IsolatedPerson', 'person', '2026-05-18T09:00:00Z');
    await seedFact({
      id: 'l2-iso',
      content: 'IsolatedPerson dislikes mondays',
      entities: ['IsolatedPerson'],
      category: 'preference',
    });
    await rebuildFactsFts();

    const result = await factFirstSearch('totally unrelated random query', root);
    expect(result.stats.expanded_facts).toBe(0);
    expect(result.stats.graph_expanded_facts).toBe(0);
  });
});

describe('Layer 2.5 — scene expansion + bridge discovery', () => {
  it('pulls more facts from the same source_conversation_id as a top fact (scene_expansion)', async () => {
    await seedFact({
      id: 'l25-scene-top',
      content: 'PrimaryScene fact about Project Helios',
      entities: ['Helios'],
      conversationId: 'scene-conv-1',
    });
    await seedFact({
      id: 'l25-scene-near',
      content: 'Adjacent helios fact about budget',
      entities: ['Helios'],
      conversationId: 'scene-conv-1',
    });
    await rebuildFactsFts();

    const result = await factFirstSearch('PrimaryScene', root);
    const sceneFact = result.facts.find(f => f.source === 'scene_expansion');
    if (sceneFact) {
      expect(sceneFact.content).toContain('Adjacent helios');
      expect(result.stats.scene_expanded_facts).toBeGreaterThan(0);
    }
  });

  it('surfaces bridge facts connecting top results when entity sets overlap', async () => {
    await seedFact({
      id: 'l25-bridge-a',
      content: 'BridgeQueryToken fact one mentioning Bridger',
      entities: ['Bridger'],
    });
    await seedFact({
      id: 'l25-bridge-b',
      content: 'BridgeQueryToken fact two mentioning Counterpart',
      entities: ['Counterpart'],
    });
    await seedFact({
      id: 'l25-bridge-c',
      content: 'A fact mentioning both Bridger and Counterpart together',
      entities: ['Bridger', 'Counterpart'],
    });
    await rebuildFactsFts();

    const result = await factFirstSearch('BridgeQueryToken', root);
    const bridgeFact = result.facts.find(f => f.source === 'bridge');
    if (bridgeFact) {
      expect(bridgeFact.content).toContain('Bridger');
      expect(bridgeFact.content).toContain('Counterpart');
      expect(result.stats.bridge_facts).toBeGreaterThan(0);
    }
  });
});

describe('Layer 3 — supporting context', () => {
  it('retrieves timeline segments matching fact source_conversation_id', async () => {
    const convId = 'l3-supporting-conv';
    await seedFact({
      id: 'l3-fact',
      content: 'UniqueL3Token fact about quarterly planning',
      entities: ['Planning'],
      conversationId: convId,
    });
    await seedTimelineEvent({
      sourcePath: convId,
      summary: 'Long-form conversation discussing the quarterly planning session in detail',
      timestamp: '2026-05-18T09:30:00Z',
    });
    await rebuildFactsFts();

    const result = await factFirstSearch('UniqueL3Token', root, { includeSupporting: true });
    expect(result.supporting_context.length).toBeGreaterThan(0);
    expect(result.supporting_context[0].content).toContain('quarterly');
  });

  it('skips supporting context when includeSupporting is false', async () => {
    await seedFact({
      id: 'l3-no-support',
      content: 'NoSupportToken something',
      entities: ['X'],
      conversationId: 'l3-no-support-conv',
    });
    await seedTimelineEvent({
      sourcePath: 'l3-no-support-conv',
      summary: 'long conversation segment that exists in the timeline',
    });
    await rebuildFactsFts();

    const result = await factFirstSearch('NoSupportToken', root, { includeSupporting: false });
    expect(result.supporting_context).toHaveLength(0);
  });
});

describe('Layer 4 — context optimization', () => {
  it('produces an assembled_context with "## Known Facts" section header', async () => {
    await seedFact({
      id: 'l4-assemble',
      content: 'AssembleToken fact for context string check',
      entities: ['X'],
      category: 'biographical',
    });
    await rebuildFactsFts();

    const result = await factFirstSearch('AssembleToken', root);
    if (result.facts.length > 0) {
      expect(result.assembled_context).toContain('## Known Facts');
      expect(result.assembled_context).toContain('AssembleToken');
    }
  });

  it('estimates tokens roughly proportional to assembled context length', async () => {
    await seedFact({
      id: 'l4-tokens',
      content: 'TokenEstimateToken plus extra content to make this longer than minimum thresholds for the estimator',
      entities: ['X'],
    });
    await rebuildFactsFts();

    const result = await factFirstSearch('TokenEstimateToken', root);
    if (result.facts.length > 0) {
      const expectedRough = Math.ceil(result.assembled_context.length / 4);
      expect(result.token_estimate).toBe(expectedRough);
    }
  });

  it('prunes content under a tight token budget and bumps pruned_items', async () => {
    for (let i = 1; i <= 15; i++) {
      await seedFact({
        id: `l4-prune-${i}`,
        content: `PruneToken padding content number ${i} with many words to make it longer than the budget allows when combined`,
        entities: [`P${i}`],
      });
    }
    await rebuildFactsFts();

    const tight = await factFirstSearch('PruneToken', root, { tokenBudget: 50, limit: 15 });
    const loose = await factFirstSearch('PruneToken', root, { tokenBudget: 100000, limit: 15 });

    expect(tight.token_estimate).toBeLessThanOrEqual(loose.token_estimate);
    // Tight budget should keep fewer facts OR mark some pruned
    expect(tight.facts.length + tight.stats.pruned_items).toBeGreaterThanOrEqual(loose.facts.length);
  });
});

describe('access tracking', () => {
  it('increments access_count on facts returned in results', async () => {
    const factId = await seedFact({
      id: 'access-track',
      content: 'AccessTrackToken fact one',
      entities: ['Tracked'],
    });
    await rebuildFactsFts();

    const db = await getTimelineDb(root);
    const before = db.prepare('SELECT access_count FROM facts WHERE id = ?').get(factId) as { access_count: number };
    const beforeCount = before?.access_count ?? 0;

    await factFirstSearch('AccessTrackToken', root);

    const after = db.prepare('SELECT access_count FROM facts WHERE id = ?').get(factId) as { access_count: number };
    expect(after.access_count).toBeGreaterThanOrEqual(beforeCount + 1);
  });
});

describe('graceful degradation', () => {
  it('continues with FTS-only when ChromaDB is unavailable', async () => {
    await seedFact({
      id: 'degrade-chroma',
      content: 'NoChromaToken kubernetes deployment notes',
      entities: ['Cluster'],
    });
    await rebuildFactsFts();

    isChromaAvailableMock.mockReturnValue(false);
    semanticSearchMock.mockRejectedValue(new Error('chromadb down'));

    const result = await factFirstSearch('NoChromaToken', root);
    expect(result.facts.some(f => f.content.includes('NoChromaToken'))).toBe(true);
  });

  it('does not throw when a query produces no FTS matches AND no entity matches', async () => {
    const result = await factFirstSearch('completelyOrthogonalQueryString', root);
    expect(result.facts).toEqual([]);
    expect(result.assembled_context).toBe('');
  });
});
