import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFileSync, existsSync } from 'fs';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// fact-store's indexDocument call goes through embeddings.js — stub it to a no-op.
vi.mock('./embeddings.js', () => ({
  indexDocument: vi.fn(async () => 0),
  isChromaAvailable: vi.fn(() => false),
}));

const {
  generateUserProfile,
  getCachedProfile,
  cacheProfile,
  getProfileAge,
  formatProfileForPrompt,
} = await import('./user-profile.js');
const { ensureFactsTable, storeFact } = await import('./fact-store.js');
const { findOrCreateEntity } = await import('./entity-graph.js');
const { getTimelineDb, resetTimelineDb } = await import('./timeline.js');
const { resetEntityGraphDb } = await import('./entity-graph.js');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-user-profile-'));
  await ensureFactsTable(root);
});

afterAll(async () => {
  resetTimelineDb(root);
  resetEntityGraphDb(root);
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  // Drop broken fact-store FTS triggers — same workaround as fact-store.test.ts.
  const db = await getTimelineDb(root);
  db.exec(`DROP TRIGGER IF EXISTS facts_fts_ai`);
  db.exec(`DROP TRIGGER IF EXISTS facts_fts_ad`);
  db.exec(`DROP TRIGGER IF EXISTS facts_fts_au`);
  db.exec(`DROP TABLE IF EXISTS facts_fts`);
});

async function seedFact(content: string, category: 'biographical' | 'preference' | 'relationship' | 'plan' | 'event' | 'temporal' | 'opinion' | 'general', extras: { confidence?: number; timestamp?: string; suffix?: string } = {}): Promise<number> {
  const suffix = extras.suffix ?? Math.random().toString(36).slice(2, 8);
  return storeFact(root, {
    content,
    source_path: `/up/${category}-${suffix}`,
    source_conversation_id: `conv-${suffix}`,
    entities: ['User'],
    timestamp: extras.timestamp ?? '2026-05-18T10:00:00Z',
    confidence: extras.confidence ?? 0.7,
    category,
  });
}

describe('generateUserProfile — section assembly', () => {
  it('returns the documented UserProfile shape with all 5 sections', async () => {
    const profile = await generateUserProfile(root);
    expect(profile).toMatchObject({
      generated_at: expect.any(String),
      fact_count: expect.any(Number),
      sections: {
        identity: expect.any(Array),
        preferences: expect.any(Array),
        relationships: expect.any(Array),
        current_plans: expect.any(Array),
        recent_events: expect.any(Array),
      },
      top_entities: expect.any(Array),
    });
  });

  it('queries each category into its own section', async () => {
    await seedFact('UserProfileTest: identity fact about the user', 'biographical', { suffix: 'id-1' });
    await seedFact('UserProfileTest: preferred coffee variety', 'preference', { suffix: 'pref-1' });
    await seedFact('UserProfileTest: relationship with team lead', 'relationship', { suffix: 'rel-1' });
    await seedFact('UserProfileTest: planning the launch', 'plan', { suffix: 'plan-1' });
    await seedFact('UserProfileTest: shipped the release', 'event', { suffix: 'evt-1' });

    const profile = await generateUserProfile(root);
    expect(profile.sections.identity.some(f => f.includes('identity fact'))).toBe(true);
    expect(profile.sections.preferences.some(f => f.includes('preferred coffee'))).toBe(true);
    expect(profile.sections.relationships.some(f => f.includes('team lead'))).toBe(true);
    expect(profile.sections.current_plans.some(f => f.includes('launch'))).toBe(true);
    expect(profile.sections.recent_events.some(f => f.includes('shipped'))).toBe(true);
  });

  it('orders identity / preferences / relationships / plans by confidence DESC', async () => {
    await seedFact('UPOrderTest: identity low confidence', 'biographical', { suffix: 'ord-low', confidence: 0.5 });
    await seedFact('UPOrderTest: identity high confidence', 'biographical', { suffix: 'ord-high', confidence: 0.9 });

    const profile = await generateUserProfile(root);
    const lowIdx = profile.sections.identity.findIndex(f => f.includes('low confidence'));
    const highIdx = profile.sections.identity.findIndex(f => f.includes('high confidence'));
    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('recent_events ordered by timestamp DESC', async () => {
    await seedFact('UPRecentTest: older event', 'event', { suffix: 'old-evt', timestamp: '2025-01-01T10:00:00Z' });
    await seedFact('UPRecentTest: newer event', 'event', { suffix: 'new-evt', timestamp: '2026-12-01T10:00:00Z' });

    const profile = await generateUserProfile(root);
    const newerIdx = profile.sections.recent_events.findIndex(f => f.includes('newer event'));
    const olderIdx = profile.sections.recent_events.findIndex(f => f.includes('older event'));
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeGreaterThanOrEqual(0);
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it('fact_count aggregates across all 5 sections', async () => {
    const baseline = await generateUserProfile(root);
    await seedFact('UPCountTest: new identity fact', 'biographical', { suffix: 'count-id' });
    await seedFact('UPCountTest: new preference fact', 'preference', { suffix: 'count-pref' });
    const after = await generateUserProfile(root);
    expect(after.fact_count).toBeGreaterThanOrEqual(baseline.fact_count + 2);
  });

  it('excludes facts that have been retracted (is_latest = 0)', async () => {
    const factId = await seedFact('UPRetractedTest: should not appear', 'biographical', { suffix: 'retracted' });
    const db = await getTimelineDb(root);
    db.prepare('UPDATE facts SET is_latest = 0 WHERE id = ?').run(factId);

    const profile = await generateUserProfile(root);
    expect(profile.sections.identity.some(f => f.includes('should not appear'))).toBe(false);
  });

  it('excludes facts whose expires_at is in the past', async () => {
    await storeFact(root, {
      content: 'UPExpiredTest: stale plan from last quarter',
      source_path: '/up/expired',
      source_conversation_id: 'conv-expired',
      entities: ['User'],
      timestamp: '2025-01-01T10:00:00Z',
      confidence: 0.9,
      category: 'plan',
      expires_at: '2025-02-01T00:00:00Z',  // in the past
    });

    const profile = await generateUserProfile(root);
    expect(profile.sections.current_plans.some(f => f.includes('stale plan'))).toBe(false);
  });
});

describe('generateUserProfile — top_entities', () => {
  it('returns empty top_entities when no entity-graph database exists', async () => {
    const freshRoot = await mkdtemp(join(tmpdir(), 'kyberbot-up-no-entities-'));
    try {
      await ensureFactsTable(freshRoot);
      const profile = await generateUserProfile(freshRoot);
      expect(profile.top_entities).toEqual([]);
    } finally {
      const db = await getTimelineDb(freshRoot);
      db.close();
      resetTimelineDb(freshRoot);
      await rm(freshRoot, { recursive: true, force: true });
    }
  });

  it('includes top entities ordered by mention_count DESC', async () => {
    await findOrCreateEntity(root, 'UPTopEntityHigh', 'person', '2026-05-18T10:00:00Z');
    await findOrCreateEntity(root, 'UPTopEntityHigh', 'person', '2026-05-18T10:00:00Z');
    await findOrCreateEntity(root, 'UPTopEntityHigh', 'person', '2026-05-18T10:00:00Z');
    await findOrCreateEntity(root, 'UPTopEntityLow', 'person', '2026-05-18T10:00:00Z');

    const profile = await generateUserProfile(root);
    const high = profile.top_entities.find(e => e.name === 'UPTopEntityHigh');
    const low = profile.top_entities.find(e => e.name === 'UPTopEntityLow');
    expect(high).toBeDefined();
    expect(low).toBeDefined();
    expect(high!.mention_count).toBeGreaterThan(low!.mention_count);

    const highIdx = profile.top_entities.findIndex(e => e.name === 'UPTopEntityHigh');
    const lowIdx = profile.top_entities.findIndex(e => e.name === 'UPTopEntityLow');
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('limits top_entities to 10', async () => {
    const profile = await generateUserProfile(root);
    expect(profile.top_entities.length).toBeLessThanOrEqual(10);
  });
});

describe('getCachedProfile / cacheProfile', () => {
  it('returns null when no cache file exists', async () => {
    const freshRoot = await mkdtemp(join(tmpdir(), 'kyberbot-up-nocache-'));
    try {
      expect(getCachedProfile(freshRoot)).toBeNull();
    } finally {
      await rm(freshRoot, { recursive: true, force: true });
    }
  });

  it('round-trips a profile through cache + retrieval', async () => {
    const original = await generateUserProfile(root);
    cacheProfile(root, original);
    const restored = getCachedProfile(root);
    expect(restored).not.toBeNull();
    expect(restored!.generated_at).toBe(original.generated_at);
    expect(restored!.fact_count).toBe(original.fact_count);
    expect(restored!.sections.identity).toEqual(original.sections.identity);
  });

  it('returns null when cache file is malformed JSON', async () => {
    const freshRoot = await mkdtemp(join(tmpdir(), 'kyberbot-up-malformed-'));
    try {
      const path = join(freshRoot, 'data', 'user-profile.json');
      await rm(join(freshRoot, 'data'), { recursive: true, force: true });
      // mkdir + write malformed content
      const fs = await import('fs/promises');
      await fs.mkdir(join(freshRoot, 'data'), { recursive: true });
      await writeFile(path, 'this is not JSON at all');
      expect(getCachedProfile(freshRoot)).toBeNull();
    } finally {
      await rm(freshRoot, { recursive: true, force: true });
    }
  });

  it('cacheProfile writes pretty-printed JSON to data/user-profile.json', async () => {
    const profile = await generateUserProfile(root);
    cacheProfile(root, profile);
    const path = join(root, 'data', 'user-profile.json');
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf-8');
    expect(raw).toContain('\n');  // pretty-printed (multi-line)
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe('getProfileAge', () => {
  it('returns Infinity when no cache exists', async () => {
    const freshRoot = await mkdtemp(join(tmpdir(), 'kyberbot-up-noage-'));
    try {
      expect(getProfileAge(freshRoot)).toBe(Infinity);
    } finally {
      await rm(freshRoot, { recursive: true, force: true });
    }
  });

  it('returns a positive number of minutes when a cached profile exists', async () => {
    const profile = await generateUserProfile(root);
    cacheProfile(root, profile);
    const age = getProfileAge(root);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(10);  // should be < 10 minutes old
  });
});

describe('formatProfileForPrompt', () => {
  function emptyProfile(): import('./user-profile.js').UserProfile {
    return {
      generated_at: '2026-05-18T10:00:00Z',
      fact_count: 0,
      sections: {
        identity: [],
        preferences: [],
        relationships: [],
        current_plans: [],
        recent_events: [],
      },
      top_entities: [],
    };
  }

  it('always includes the top-level header', () => {
    const out = formatProfileForPrompt(emptyProfile());
    expect(out).toContain('## Auto-Generated User Profile');
  });

  it('includes section headers only when the section is non-empty', () => {
    const out = formatProfileForPrompt(emptyProfile());
    expect(out).not.toContain('### Identity');
    expect(out).not.toContain('### Preferences');
    expect(out).not.toContain('### Key Relationships');
    expect(out).not.toContain('### Current Plans');
    expect(out).not.toContain('### Recent Events');
  });

  it('renders each section as bulleted markdown', () => {
    const p = emptyProfile();
    p.sections.identity = ['I live in Tokyo'];
    p.sections.preferences = ['I prefer oat milk'];
    p.sections.relationships = ['Bob is my colleague'];
    p.sections.current_plans = ['Ship the launch'];
    p.sections.recent_events = ['Closed Q3 review'];

    const out = formatProfileForPrompt(p);
    expect(out).toContain('### Identity');
    expect(out).toContain('- I live in Tokyo');
    expect(out).toContain('### Preferences');
    expect(out).toContain('- I prefer oat milk');
    expect(out).toContain('### Key Relationships');
    expect(out).toContain('- Bob is my colleague');
    expect(out).toContain('### Current Plans');
    expect(out).toContain('- Ship the launch');
    expect(out).toContain('### Recent Events');
    expect(out).toContain('- Closed Q3 review');
  });
});
