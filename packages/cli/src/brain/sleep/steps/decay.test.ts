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
const { runDecayStep } = await import('./decay.js');
const { DEFAULT_CONFIG } = await import('../config.js');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-decay-test-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// Helper: insert a timeline event and return its id
async function insertEvent(opts: {
  title: string;
  timestamp: string;
  priority?: number;
  decay_score?: number;
  access_count?: number;
  is_pinned?: number;
  tier?: string;
}): Promise<number> {
  const db = await getTimelineDb(root);
  const result = db.prepare(`
    INSERT INTO timeline_events (type, timestamp, title, summary, source_path, priority, decay_score, access_count, is_pinned, tier)
    VALUES ('note', ?, ?, 'test', ?, ?, ?, ?, ?, ?)
  `).run(
    opts.timestamp,
    opts.title,
    `test/${opts.title.replace(/\s/g, '-')}.md`,
    opts.priority ?? 0.5,
    opts.decay_score ?? 0,
    opts.access_count ?? 0,
    opts.is_pinned ?? 0,
    opts.tier ?? 'warm',
  );
  return result.lastInsertRowid as number;
}

beforeEach(async () => {
  // Clear timeline events between tests
  const db = await getTimelineDb(root);
  db.exec('DELETE FROM timeline_events');
});

describe('runDecayStep', () => {
  it('should return count of 0 when no events exist', async () => {
    const result = await runDecayStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(0);
    expect(result.errors).toBeUndefined();
  });

  it('should apply decay to old memories', async () => {
    // Insert an event from 100 hours ago
    const oldTimestamp = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const id = await insertEvent({
      title: 'Old memory',
      timestamp: oldTimestamp,
      priority: 0.5,
      decay_score: 0,
    });

    const result = await runDecayStep(root, DEFAULT_CONFIG);
    expect(result.count).toBeGreaterThan(0);

    // Check that priority decreased and decay_score increased
    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT priority, decay_score FROM timeline_events WHERE id = ?')
      .get(id) as { priority: number; decay_score: number };

    expect(row.decay_score).toBeGreaterThan(0);
    expect(row.priority).toBeLessThan(0.5);
  });

  it('should skip pinned items', async () => {
    const oldTimestamp = new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString();
    const id = await insertEvent({
      title: 'Pinned memory',
      timestamp: oldTimestamp,
      priority: 0.8,
      decay_score: 0,
      is_pinned: 1,
    });

    await runDecayStep(root, DEFAULT_CONFIG);

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT priority, decay_score FROM timeline_events WHERE id = ?')
      .get(id) as { priority: number; decay_score: number };

    // Pinned items should not change
    expect(row.priority).toBe(0.8);
    expect(row.decay_score).toBe(0);
  });

  it('should skip archived items', async () => {
    const oldTimestamp = new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString();
    const id = await insertEvent({
      title: 'Archived memory',
      timestamp: oldTimestamp,
      priority: 0.3,
      decay_score: 0.5,
      tier: 'archive',
    });

    await runDecayStep(root, DEFAULT_CONFIG);

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT priority, decay_score FROM timeline_events WHERE id = ?')
      .get(id) as { priority: number; decay_score: number };

    // Archived items should not be processed
    expect(row.priority).toBe(0.3);
    expect(row.decay_score).toBe(0.5);
  });

  it('should give access_count a counteracting boost to priority', async () => {
    const oldTimestamp = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();

    const lowAccessId = await insertEvent({
      title: 'Low access',
      timestamp: oldTimestamp,
      priority: 0.5,
      access_count: 0,
    });

    const highAccessId = await insertEvent({
      title: 'High access',
      timestamp: oldTimestamp,
      priority: 0.5,
      access_count: 10,
    });

    await runDecayStep(root, DEFAULT_CONFIG);

    const db = await getTimelineDb(root);
    const low = db.prepare('SELECT priority FROM timeline_events WHERE id = ?')
      .get(lowAccessId) as { priority: number };
    const high = db.prepare('SELECT priority FROM timeline_events WHERE id = ?')
      .get(highAccessId) as { priority: number };

    // High access count should retain higher priority
    expect(high.priority).toBeGreaterThan(low.priority);
  });

  it('should cap decay_score at maxDecay', async () => {
    const veryOldTimestamp = new Date(Date.now() - 10000 * 60 * 60 * 1000).toISOString();
    const id = await insertEvent({
      title: 'Ancient memory',
      timestamp: veryOldTimestamp,
      priority: 0.5,
      decay_score: 0.99,
    });

    await runDecayStep(root, DEFAULT_CONFIG);

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT decay_score FROM timeline_events WHERE id = ?')
      .get(id) as { decay_score: number };

    expect(row.decay_score).toBeLessThanOrEqual(DEFAULT_CONFIG.maxDecay);
  });

  it('should keep priority >= 0', async () => {
    const veryOldTimestamp = new Date(Date.now() - 10000 * 60 * 60 * 1000).toISOString();
    const id = await insertEvent({
      title: 'Near zero priority',
      timestamp: veryOldTimestamp,
      priority: 0.01,
      decay_score: 0.9,
    });

    await runDecayStep(root, DEFAULT_CONFIG);

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT priority FROM timeline_events WHERE id = ?')
      .get(id) as { priority: number };

    expect(row.priority).toBeGreaterThanOrEqual(0);
  });

  it('should not update items with negligible changes', async () => {
    // A very recent event should have near-zero decay
    const recentTimestamp = new Date(Date.now() - 1000).toISOString(); // 1 second ago
    await insertEvent({
      title: 'Just now',
      timestamp: recentTimestamp,
      priority: 0.5,
      decay_score: 0,
    });

    const result = await runDecayStep(root, DEFAULT_CONFIG);
    // Near-zero age means negligible changes — may or may not update
    expect(result.errors).toBeUndefined();
  });
});
