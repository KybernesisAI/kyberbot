import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

const { getSleepDb } = await import('../db.js');
const { saveCheckpoint, getLastCheckpoint } = await import('./checkpoint.js');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-checkpoint-test-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('saveCheckpoint', () => {
  it('should save a checkpoint step to a run', () => {
    const db = getSleepDb(root);

    const { lastInsertRowid: runId } = db.prepare(`
      INSERT INTO sleep_runs (started_at, status) VALUES (datetime('now'), 'running')
    `).run();

    saveCheckpoint(db, runId as number, 'decay');

    const row = db.prepare('SELECT checkpoint_step FROM sleep_runs WHERE id = ?')
      .get(runId) as { checkpoint_step: string };
    expect(row.checkpoint_step).toBe('decay');
  });

  it('should save checkpoint data as JSON', () => {
    const db = getSleepDb(root);

    const { lastInsertRowid: runId } = db.prepare(`
      INSERT INTO sleep_runs (started_at, status) VALUES (datetime('now'), 'running')
    `).run();

    saveCheckpoint(db, runId as number, 'tag', { processed: 15, skipped: 3 });

    const row = db.prepare('SELECT checkpoint_data FROM sleep_runs WHERE id = ?')
      .get(runId) as { checkpoint_data: string };
    const data = JSON.parse(row.checkpoint_data);
    expect(data.processed).toBe(15);
    expect(data.skipped).toBe(3);
    expect(data.timestamp).toBeDefined();
  });

  it('should overwrite previous checkpoint on same run', () => {
    const db = getSleepDb(root);

    const { lastInsertRowid: runId } = db.prepare(`
      INSERT INTO sleep_runs (started_at, status) VALUES (datetime('now'), 'running')
    `).run();

    saveCheckpoint(db, runId as number, 'decay');
    saveCheckpoint(db, runId as number, 'tier');

    const row = db.prepare('SELECT checkpoint_step FROM sleep_runs WHERE id = ?')
      .get(runId) as { checkpoint_step: string };
    expect(row.checkpoint_step).toBe('tier');
  });
});

describe('getLastCheckpoint', () => {
  it('should return null when no checkpoint exists', () => {
    const db = getSleepDb(root);

    const { lastInsertRowid: runId } = db.prepare(`
      INSERT INTO sleep_runs (started_at, status) VALUES (datetime('now'), 'running')
    `).run();

    const result = getLastCheckpoint(db, runId as number);
    expect(result).toBeNull();
  });

  it('should return the saved checkpoint', () => {
    const db = getSleepDb(root);

    const { lastInsertRowid: runId } = db.prepare(`
      INSERT INTO sleep_runs (started_at, status) VALUES (datetime('now'), 'running')
    `).run();

    saveCheckpoint(db, runId as number, 'link', { edges: 42 });

    const result = getLastCheckpoint(db, runId as number);
    expect(result).not.toBeNull();
    expect(result!.step).toBe('link');
    expect(result!.data.edges).toBe(42);
    expect(result!.data.timestamp).toBeDefined();
  });

  it('should return null for non-existent run', () => {
    const db = getSleepDb(root);
    const result = getLastCheckpoint(db, 999999);
    expect(result).toBeNull();
  });
});
