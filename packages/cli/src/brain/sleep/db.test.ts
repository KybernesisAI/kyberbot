import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock logger
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { getSleepDb, initializeSleepDb } = await import('./db.js');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-sleep-db-test-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('getSleepDb', () => {
  it('should create and return a database', () => {
    const db = getSleepDb(root);
    expect(db).toBeDefined();
    expect(db.open).toBe(true);
  });

  it('should return the same instance for the same root', () => {
    const db1 = getSleepDb(root);
    const db2 = getSleepDb(root);
    expect(db1).toBe(db2);
  });

  it('should create the sleep_runs table', () => {
    const db = getSleepDb(root);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sleep_runs'"
    ).all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('sleep_runs');
  });

  it('should create the maintenance_queue table', () => {
    const db = getSleepDb(root);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='maintenance_queue'"
    ).all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it('should create the memory_edges table', () => {
    const db = getSleepDb(root);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_edges'"
    ).all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it('should create the sleep_telemetry table', () => {
    const db = getSleepDb(root);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sleep_telemetry'"
    ).all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it('should use WAL journal mode', () => {
    const db = getSleepDb(root);
    const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(result[0].journal_mode).toBe('wal');
  });
});

describe('initializeSleepDb', () => {
  it('should initialize without error', async () => {
    const freshRoot = await mkdtemp(join(tmpdir(), 'kyberbot-sleep-init-test-'));
    await expect(initializeSleepDb(freshRoot)).resolves.toBeUndefined();
    await rm(freshRoot, { recursive: true, force: true });
  });
});

describe('sleep_runs schema', () => {
  it('should allow inserting a run', () => {
    const db = getSleepDb(root);
    const result = db.prepare(`
      INSERT INTO sleep_runs (started_at, status)
      VALUES (datetime('now'), 'running')
    `).run();
    expect(result.lastInsertRowid).toBeGreaterThan(0);
  });

  it('should enforce valid status values', () => {
    const db = getSleepDb(root);
    expect(() => {
      db.prepare(`
        INSERT INTO sleep_runs (started_at, status) VALUES (datetime('now'), 'invalid')
      `).run();
    }).toThrow();
  });

  it('should allow completing a run with metrics', () => {
    const db = getSleepDb(root);
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO sleep_runs (started_at, status)
      VALUES (datetime('now'), 'running')
    `).run();

    db.prepare(`
      UPDATE sleep_runs
      SET status = 'completed', completed_at = datetime('now'), metrics = ?
      WHERE id = ?
    `).run(JSON.stringify({ decay: { count: 5 } }), lastInsertRowid);

    const row = db.prepare('SELECT status, metrics FROM sleep_runs WHERE id = ?')
      .get(lastInsertRowid) as { status: string; metrics: string };
    expect(row.status).toBe('completed');
    expect(JSON.parse(row.metrics)).toEqual({ decay: { count: 5 } });
  });
});

describe('maintenance_queue schema', () => {
  it('should allow inserting queue items', () => {
    const db = getSleepDb(root);
    const result = db.prepare(`
      INSERT INTO maintenance_queue (item_type, item_id, task, priority)
      VALUES ('timeline', '42', 'retag', 1)
    `).run();
    expect(result.lastInsertRowid).toBeGreaterThan(0);
  });

  it('should enforce unique constraint on (item_type, item_id, task)', () => {
    const db = getSleepDb(root);
    db.prepare(`
      INSERT OR REPLACE INTO maintenance_queue (item_type, item_id, task, priority)
      VALUES ('timeline', 'unique-test', 'relink', 1)
    `).run();

    // Second insert with same key should replace
    db.prepare(`
      INSERT OR REPLACE INTO maintenance_queue (item_type, item_id, task, priority)
      VALUES ('timeline', 'unique-test', 'relink', 2)
    `).run();

    const rows = db.prepare(
      "SELECT * FROM maintenance_queue WHERE item_id = 'unique-test' AND task = 'relink'"
    ).all();
    expect(rows).toHaveLength(1);
  });

  it('should enforce valid item_type values', () => {
    const db = getSleepDb(root);
    expect(() => {
      db.prepare(`
        INSERT INTO maintenance_queue (item_type, item_id, task) VALUES ('invalid', '1', 'retag')
      `).run();
    }).toThrow();
  });

  it('should enforce valid task values', () => {
    const db = getSleepDb(root);
    expect(() => {
      db.prepare(`
        INSERT INTO maintenance_queue (item_type, item_id, task) VALUES ('timeline', '1', 'invalid')
      `).run();
    }).toThrow();
  });
});

describe('memory_edges schema', () => {
  it('should allow inserting an edge', () => {
    const db = getSleepDb(root);
    const result = db.prepare(`
      INSERT INTO memory_edges (from_path, to_path, relation, confidence)
      VALUES ('a.md', 'b.md', 'related', 0.8)
    `).run();
    expect(result.lastInsertRowid).toBeGreaterThan(0);
  });

  it('should enforce unique (from_path, to_path)', () => {
    const db = getSleepDb(root);
    db.prepare(`
      INSERT OR REPLACE INTO memory_edges (from_path, to_path, relation, confidence)
      VALUES ('x.md', 'y.md', 'related', 0.5)
    `).run();
    db.prepare(`
      INSERT OR REPLACE INTO memory_edges (from_path, to_path, relation, confidence)
      VALUES ('x.md', 'y.md', 'same_topic', 0.9)
    `).run();

    const rows = db.prepare(
      "SELECT * FROM memory_edges WHERE from_path = 'x.md' AND to_path = 'y.md'"
    ).all();
    expect(rows).toHaveLength(1);
  });

  it('should enforce valid relation values', () => {
    const db = getSleepDb(root);
    expect(() => {
      db.prepare(`
        INSERT INTO memory_edges (from_path, to_path, relation) VALUES ('a.md', 'c.md', 'invalid')
      `).run();
    }).toThrow();
  });

  it('should enforce valid method values', () => {
    const db = getSleepDb(root);
    expect(() => {
      db.prepare(`
        INSERT INTO memory_edges (from_path, to_path, relation, method)
        VALUES ('a.md', 'd.md', 'related', 'invalid')
      `).run();
    }).toThrow();
  });
});

describe('sleep_telemetry schema', () => {
  it('should allow inserting telemetry', () => {
    const db = getSleepDb(root);

    // Create a run first for the FK
    const { lastInsertRowid: runId } = db.prepare(`
      INSERT INTO sleep_runs (started_at, status) VALUES (datetime('now'), 'running')
    `).run();

    const result = db.prepare(`
      INSERT INTO sleep_telemetry (run_id, step, event_type, count, duration_ms)
      VALUES (?, 'decay', 'step_completed', 10, 250)
    `).run(runId);
    expect(result.lastInsertRowid).toBeGreaterThan(0);
  });
});
