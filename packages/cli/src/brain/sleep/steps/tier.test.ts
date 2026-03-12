import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock logger
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { getTimelineDb } = await import('../../timeline.js');
const { getSleepDb } = await import('../db.js');
const { runTierStep } = await import('./tier.js');
const { DEFAULT_CONFIG } = await import('../config.js');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-tier-test-'));
  // Initialize both databases
  await getTimelineDb(root);
  getSleepDb(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// Helper: insert a timeline event
async function insertEvent(opts: {
  title: string;
  timestamp?: string;
  priority?: number;
  decay_score?: number;
  tier?: string;
  last_accessed?: string;
  access_count?: number;
  is_pinned?: number;
}): Promise<number> {
  const db = await getTimelineDb(root);
  const result = db.prepare(`
    INSERT INTO timeline_events (type, timestamp, title, summary, source_path, priority, decay_score, tier, last_accessed, access_count, is_pinned)
    VALUES ('note', ?, ?, 'test summary', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.timestamp ?? new Date().toISOString(),
    opts.title,
    `test/${opts.title.replace(/\s/g, '-')}.md`,
    opts.priority ?? 0.5,
    opts.decay_score ?? 0,
    opts.tier ?? 'warm',
    opts.last_accessed ?? null,
    opts.access_count ?? 0,
    opts.is_pinned ?? 0,
  );
  return result.lastInsertRowid as number;
}

beforeEach(async () => {
  const timeline = await getTimelineDb(root);
  timeline.exec('DELETE FROM timeline_events');

  const sleep = getSleepDb(root);
  sleep.exec('DELETE FROM memory_edges');
  sleep.exec('DELETE FROM maintenance_queue');
});

describe('runTierStep', () => {
  it('should return count of 0 when no events exist', async () => {
    const result = await runTierStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(0);
    expect(result.errors).toBeUndefined();
  });

  it('should promote high-priority items to hot', async () => {
    const id = await insertEvent({
      title: 'High priority item',
      priority: 0.8, // Above hotPriorityThreshold (0.65)
      tier: 'warm',
    });

    const result = await runTierStep(root, DEFAULT_CONFIG);
    expect(result.count).toBeGreaterThan(0);

    const timeline = await getTimelineDb(root);
    const row = timeline.prepare('SELECT tier FROM timeline_events WHERE id = ?')
      .get(id) as { tier: string };
    expect(row.tier).toBe('hot');
  });

  it('should demote low-priority old items to archive', async () => {
    // SQLite datetime format (no Z — tier.ts appends 'Z' itself)
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const oldAccess = oldDate.toISOString().replace('Z', '').replace('T', ' ').slice(0, 19);
    const id = await insertEvent({
      title: 'Old low priority',
      priority: 0.1, // Below warmPriorityThreshold (0.3)
      decay_score: 0.8, // Above hotDecayThreshold
      tier: 'warm',
      last_accessed: oldAccess, // > warmAccessDays (21)
    });

    const result = await runTierStep(root, DEFAULT_CONFIG);
    expect(result.count).toBeGreaterThan(0);

    const timeline = await getTimelineDb(root);
    const row = timeline.prepare('SELECT tier FROM timeline_events WHERE id = ?')
      .get(id) as { tier: string };
    expect(row.tier).toBe('archive');
  });

  it('should keep items in warm when they meet warm thresholds', async () => {
    const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const recentAccess = recentDate.toISOString().replace('Z', '').replace('T', ' ').slice(0, 19);
    const id = await insertEvent({
      title: 'Warm item',
      priority: 0.4, // Above warmPriorityThreshold (0.3) but below hot (0.65)
      decay_score: 0.5, // Above hotDecayThreshold (0.25)
      tier: 'warm',
      last_accessed: recentAccess, // Within warmAccessDays (21)
    });

    const result = await runTierStep(root, DEFAULT_CONFIG);

    const timeline = await getTimelineDb(root);
    const row = timeline.prepare('SELECT tier FROM timeline_events WHERE id = ?')
      .get(id) as { tier: string };
    expect(row.tier).toBe('warm');
  });

  it('should force pinned items to hot tier', async () => {
    const id = await insertEvent({
      title: 'Pinned item',
      priority: 0.1, // Low priority
      tier: 'archive',
      is_pinned: 1,
    });

    const result = await runTierStep(root, DEFAULT_CONFIG);
    expect(result.count).toBeGreaterThan(0);

    const timeline = await getTimelineDb(root);
    const row = timeline.prepare('SELECT tier FROM timeline_events WHERE id = ?')
      .get(id) as { tier: string };
    expect(row.tier).toBe('hot');
  });

  it('should promote items with many edges to hot', async () => {
    const id = await insertEvent({
      title: 'Well connected item',
      priority: 0.4,
      decay_score: 0.5,
      tier: 'warm',
    });

    // Add 5 edges with high confidence (sum >= hotEdgeCount threshold of 6)
    const sleep = getSleepDb(root);
    for (let i = 0; i < 5; i++) {
      sleep.prepare(`
        INSERT INTO memory_edges (from_path, to_path, relation, confidence)
        VALUES (?, ?, 'related', 1.5)
      `).run(`test/Well-connected-item.md`, `other-${i}.md`);
    }

    const result = await runTierStep(root, DEFAULT_CONFIG);

    const timeline = await getTimelineDb(root);
    const row = timeline.prepare('SELECT tier FROM timeline_events WHERE id = ?')
      .get(id) as { tier: string };
    expect(row.tier).toBe('hot');
  });

  it('should promote recently accessed items to hot', async () => {
    // SQLite datetime() produces "YYYY-MM-DD HH:MM:SS" (no Z), and tier.ts appends 'Z'
    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const recentAccess = recentDate.toISOString().replace('Z', '').replace('T', ' ').slice(0, 19); // SQLite format
    const id = await insertEvent({
      title: 'Recently accessed',
      priority: 0.4,
      decay_score: 0.5,
      tier: 'warm',
      last_accessed: recentAccess, // Within hotAccessDays (3)
    });

    await runTierStep(root, DEFAULT_CONFIG);

    const timeline = await getTimelineDb(root);
    const row = timeline.prepare('SELECT tier FROM timeline_events WHERE id = ?')
      .get(id) as { tier: string };
    expect(row.tier).toBe('hot');
  });

  it('should queue tier-changed items for re-summarization', async () => {
    await insertEvent({
      title: 'Promoted item',
      priority: 0.8,
      tier: 'warm',
    });

    await runTierStep(root, DEFAULT_CONFIG);

    const sleep = getSleepDb(root);
    const queueItems = sleep.prepare(
      "SELECT * FROM maintenance_queue WHERE task = 'resummarize'"
    ).all();
    expect(queueItems.length).toBeGreaterThan(0);
  });

  it('should not change items already in the correct tier', async () => {
    await insertEvent({
      title: 'Already hot',
      priority: 0.8,
      tier: 'hot',
    });

    const result = await runTierStep(root, DEFAULT_CONFIG);
    // Item is already hot and meets hot threshold — no change needed
    expect(result.count).toBe(0);
  });

  it('should handle items with low decay score as hot candidates', async () => {
    const id = await insertEvent({
      title: 'Low decay item',
      priority: 0.4, // Below hot priority threshold
      decay_score: 0.1, // Below hotDecayThreshold (0.25)
      tier: 'warm',
    });

    await runTierStep(root, DEFAULT_CONFIG);

    const timeline = await getTimelineDb(root);
    const row = timeline.prepare('SELECT tier FROM timeline_events WHERE id = ?')
      .get(id) as { tier: string };
    expect(row.tier).toBe('hot');
  });
});
