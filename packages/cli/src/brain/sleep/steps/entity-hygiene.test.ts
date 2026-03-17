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

// Mock Claude client
const mockComplete = vi.fn();
vi.mock('../../../claude.js', () => ({
  getClaudeClient: () => ({
    complete: mockComplete,
  }),
}));

// Mock withRetry to just call the function directly
vi.mock('../../../utils/retry.js', () => ({
  withRetry: async (fn: () => Promise<string>) => fn(),
}));

const { getEntityGraphDb } = await import('../../entity-graph.js');
const { findOrCreateEntity, addEntityMention, linkEntities } = await import('../../entity-graph.js');
const { runEntityHygieneStep } = await import('./entity-hygiene.js');
const { DEFAULT_CONFIG } = await import('../config.js');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-entity-hygiene-test-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  mockComplete.mockReset();
  // Clear all entity tables between tests
  const db = await getEntityGraphDb(root);
  db.exec('DELETE FROM entity_mentions');
  db.exec('DELETE FROM entity_relations');
  db.exec('DELETE FROM entities');
  // Clear merge_history if it exists
  try { db.exec('DELETE FROM merge_history'); } catch { /* table may not exist */ }
});

// ─────────────────────────────────────────────────────────────────────────────
// Disabled flag
// ─────────────────────────────────────────────────────────────────────────────

describe('entity hygiene — disabled', () => {
  it('returns zeroed result when enableEntityHygiene is false', async () => {
    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: false };
    const result = await runEntityHygieneStep(root, config);

    expect(result.count).toBe(0);
    expect(result.artifactsCleaned).toBe(0);
    expect(result.merged).toBe(0);
    expect(result.pruned).toBe(0);
    expect(result.assessed).toBe(0);
    expect(result.errors).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: Artifact cleanup
// ─────────────────────────────────────────────────────────────────────────────

describe('entity hygiene — artifact cleanup', () => {
  it('removes "Speaker 0" artifact entities', async () => {
    await findOrCreateEntity(root, 'Speaker 0', 'person', '2025-01-01T00:00:00Z');
    await findOrCreateEntity(root, 'Speaker 1', 'person', '2025-01-01T00:00:00Z');
    await findOrCreateEntity(root, 'Alice', 'person', '2025-01-01T00:00:00Z');

    // Mock Claude for AI phases (shouldn't be needed for artifacts)
    mockComplete.mockResolvedValue('[]');

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true };
    const result = await runEntityHygieneStep(root, config);

    expect(result.artifactsCleaned).toBe(2);

    // Alice should still exist
    const db = await getEntityGraphDb(root);
    const remaining = db.prepare('SELECT name FROM entities').all() as Array<{ name: string }>;
    expect(remaining.map(r => r.name)).toEqual(['Alice']);
  });

  it('removes "Unknown" artifact entities (case-insensitive)', async () => {
    await findOrCreateEntity(root, 'unknown', 'person', '2025-01-01T00:00:00Z');
    await findOrCreateEntity(root, 'UNKNOWN', 'person', '2025-01-01T00:00:00Z');

    mockComplete.mockResolvedValue('[]');

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true };
    const result = await runEntityHygieneStep(root, config);

    // They share normalized_name so only one was created, but it matches artifact pattern
    expect(result.artifactsCleaned).toBeGreaterThanOrEqual(1);
  });

  it('removes "User" and "Narrator" artifact entities', async () => {
    await findOrCreateEntity(root, 'User', 'person', '2025-01-01T00:00:00Z');
    await findOrCreateEntity(root, 'Narrator', 'person', '2025-01-01T00:00:00Z');
    await findOrCreateEntity(root, 'Person 42', 'person', '2025-01-01T00:00:00Z');

    mockComplete.mockResolvedValue('[]');

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true };
    const result = await runEntityHygieneStep(root, config);

    expect(result.artifactsCleaned).toBe(3);
  });

  it('respects maxMergesPerRun limit during artifact cleanup', async () => {
    // Create more artifacts than maxMergesPerRun
    for (let i = 0; i < 5; i++) {
      await findOrCreateEntity(root, `Speaker ${i}`, 'person', '2025-01-01T00:00:00Z');
    }

    mockComplete.mockResolvedValue('[]');

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true, maxMergesPerRun: 3 };
    const result = await runEntityHygieneStep(root, config);

    expect(result.artifactsCleaned).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 0: Orphaned relations cleanup
// ─────────────────────────────────────────────────────────────────────────────

describe('entity hygiene — orphaned cleanup', () => {
  it('cleans orphaned relations referencing deleted entities', async () => {
    const alice = await findOrCreateEntity(root, 'Alice', 'person', '2025-01-01T00:00:00Z');
    const bob = await findOrCreateEntity(root, 'Bob', 'person', '2025-01-01T00:00:00Z');

    // Create a relation
    await linkEntities(root, alice.id, bob.id, 'discussed');

    // Manually delete Bob to create an orphan
    const db = await getEntityGraphDb(root);
    db.prepare('DELETE FROM entities WHERE id = ?').run(bob.id);

    mockComplete.mockResolvedValue('[]');

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true };
    await runEntityHygieneStep(root, config);

    // Orphaned relation should be cleaned
    const relations = db.prepare('SELECT COUNT(*) as c FROM entity_relations').get() as { c: number };
    expect(relations.c).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Same-name-different-type merge (AI assessment)
// ─────────────────────────────────────────────────────────────────────────────

describe('entity hygiene — same-name merge', () => {
  it('merges same-name entities when AI says MERGE with high confidence', async () => {
    // Create "Acme" as both a project and a company
    await findOrCreateEntity(root, 'Acme', 'project', '2025-01-01T00:00:00Z');
    const company = await findOrCreateEntity(root, 'Acme', 'company', '2025-01-01T00:00:00Z');
    // Give company more mentions so it becomes the "keep" candidate
    await findOrCreateEntity(root, 'Acme', 'company', '2025-01-02T00:00:00Z');
    await findOrCreateEntity(root, 'Acme', 'company', '2025-01-03T00:00:00Z');

    mockComplete.mockResolvedValue(JSON.stringify([
      { action: 'MERGE', confidence: 0.9, rationale: 'Same entity, Acme the company' },
    ]));

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true, hygieneConfidenceThreshold: 0.8 };
    const result = await runEntityHygieneStep(root, config);

    expect(result.merged).toBe(1);
    expect(result.assessed).toBe(1);
  });

  it('does not merge when AI says DIFFERENT', async () => {
    await findOrCreateEntity(root, 'Mercury', 'project', '2025-01-01T00:00:00Z');
    await findOrCreateEntity(root, 'Mercury', 'company', '2025-01-01T00:00:00Z');

    mockComplete.mockResolvedValue(JSON.stringify([
      { action: 'DIFFERENT', confidence: 0.95, rationale: 'Different entities' },
    ]));

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true };
    const result = await runEntityHygieneStep(root, config);

    expect(result.merged).toBe(0);
    expect(result.assessed).toBe(1);

    // Both should still exist
    const db = await getEntityGraphDb(root);
    const count = (db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it('does not merge when confidence is below threshold', async () => {
    await findOrCreateEntity(root, 'Atlas', 'project', '2025-01-01T00:00:00Z');
    await findOrCreateEntity(root, 'Atlas', 'company', '2025-01-01T00:00:00Z');

    mockComplete.mockResolvedValue(JSON.stringify([
      { action: 'MERGE', confidence: 0.5, rationale: 'Maybe same' },
    ]));

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true, hygieneConfidenceThreshold: 0.8 };
    const result = await runEntityHygieneStep(root, config);

    expect(result.merged).toBe(0);
    expect(result.assessed).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: Pruning low-value noise
// ─────────────────────────────────────────────────────────────────────────────

describe('entity hygiene — pruning', () => {
  it('prunes old single-mention topics with no relations', async () => {
    // Create an old, low-value topic
    const db = await getEntityGraphDb(root);
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
    db.prepare(`
      INSERT INTO entities (name, normalized_name, type, first_seen, last_seen, mention_count, aliases, is_pinned)
      VALUES (?, ?, 'topic', ?, ?, 1, '[]', 0)
    `).run('old-topic', 'old-topic', oldDate, oldDate);

    // Create a recent topic that should NOT be pruned
    const recentDate = new Date().toISOString();
    db.prepare(`
      INSERT INTO entities (name, normalized_name, type, first_seen, last_seen, mention_count, aliases, is_pinned)
      VALUES (?, ?, 'topic', ?, ?, 1, '[]', 0)
    `).run('new-topic', 'new-topic', recentDate, recentDate);

    mockComplete.mockResolvedValue('[]');

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true, pruneMinAgeDays: 30 };
    const result = await runEntityHygieneStep(root, config);

    expect(result.pruned).toBe(1);

    // new-topic should still exist
    const remaining = db.prepare('SELECT name FROM entities').all() as Array<{ name: string }>;
    expect(remaining.map(r => r.name)).toContain('new-topic');
    expect(remaining.map(r => r.name)).not.toContain('old-topic');
  });

  it('does not prune pinned entities', async () => {
    const db = await getEntityGraphDb(root);
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO entities (name, normalized_name, type, first_seen, last_seen, mention_count, aliases, is_pinned)
      VALUES (?, ?, 'topic', ?, ?, 1, '[]', 1)
    `).run('pinned-topic', 'pinned-topic', oldDate, oldDate);

    mockComplete.mockResolvedValue('[]');

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true, pruneMinAgeDays: 30 };
    const result = await runEntityHygieneStep(root, config);

    expect(result.pruned).toBe(0);
  });

  it('does not prune entities with relations', async () => {
    const alice = await findOrCreateEntity(root, 'Alice', 'person', '2025-01-01T00:00:00Z');

    // Create an old topic but link it to Alice
    const db = await getEntityGraphDb(root);
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO entities (name, normalized_name, type, first_seen, last_seen, mention_count, aliases, is_pinned)
      VALUES (?, ?, 'topic', ?, ?, 1, '[]', 0)
    `).run('related-topic', 'related-topic', oldDate, oldDate);
    const topicId = (db.prepare("SELECT id FROM entities WHERE name = 'related-topic'").get() as { id: number }).id;

    await linkEntities(root, alice.id, topicId, 'discussed');

    mockComplete.mockResolvedValue('[]');

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true, pruneMinAgeDays: 30 };
    const result = await runEntityHygieneStep(root, config);

    expect(result.pruned).toBe(0);
  });

  it('does not prune entities with more than 1 mention', async () => {
    const db = await getEntityGraphDb(root);
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO entities (name, normalized_name, type, first_seen, last_seen, mention_count, aliases, is_pinned)
      VALUES (?, ?, 'topic', ?, ?, 3, '[]', 0)
    `).run('mentioned-topic', 'mentioned-topic', oldDate, oldDate);

    mockComplete.mockResolvedValue('[]');

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true, pruneMinAgeDays: 30 };
    const result = await runEntityHygieneStep(root, config);

    expect(result.pruned).toBe(0);
  });

  it('does not prune non-topic entities', async () => {
    const db = await getEntityGraphDb(root);
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO entities (name, normalized_name, type, first_seen, last_seen, mention_count, aliases, is_pinned)
      VALUES (?, ?, 'person', ?, ?, 1, '[]', 0)
    `).run('old-person', 'old-person', oldDate, oldDate);

    mockComplete.mockResolvedValue('[]');

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true, pruneMinAgeDays: 30 };
    const result = await runEntityHygieneStep(root, config);

    expect(result.pruned).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AI response handling
// ─────────────────────────────────────────────────────────────────────────────

describe('entity hygiene — AI response edge cases', () => {
  it('handles invalid JSON from AI gracefully (returns UNSURE)', async () => {
    await findOrCreateEntity(root, 'Foo', 'project', '2025-01-01T00:00:00Z');
    await findOrCreateEntity(root, 'Foo', 'company', '2025-01-01T00:00:00Z');

    mockComplete.mockResolvedValue('This is not JSON at all');

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true };
    const result = await runEntityHygieneStep(root, config);

    // Should assess but not merge (UNSURE fallback)
    expect(result.assessed).toBe(1);
    expect(result.merged).toBe(0);
    expect(result.errors).toBeUndefined();
  });

  it('handles AI batch failure gracefully', async () => {
    await findOrCreateEntity(root, 'Bar', 'project', '2025-01-01T00:00:00Z');
    await findOrCreateEntity(root, 'Bar', 'company', '2025-01-01T00:00:00Z');

    mockComplete.mockRejectedValue(new Error('API rate limit'));

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true };
    const result = await runEntityHygieneStep(root, config);

    expect(result.merged).toBe(0);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('handles partial JSON array from AI', async () => {
    await findOrCreateEntity(root, 'Baz', 'project', '2025-01-01T00:00:00Z');
    await findOrCreateEntity(root, 'Baz', 'company', '2025-01-01T00:00:00Z');

    // AI returns valid JSON but fewer decisions than candidates
    mockComplete.mockResolvedValue('[]');

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true };
    const result = await runEntityHygieneStep(root, config);

    // Should pad with UNSURE and not crash
    expect(result.assessed).toBe(1);
    expect(result.merged).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Result shape
// ─────────────────────────────────────────────────────────────────────────────

describe('entity hygiene — result shape', () => {
  it('count equals artifactsCleaned + merged + pruned', async () => {
    // Create one artifact
    await findOrCreateEntity(root, 'Speaker 0', 'person', '2025-01-01T00:00:00Z');

    // Create an old prunable topic
    const db = await getEntityGraphDb(root);
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO entities (name, normalized_name, type, first_seen, last_seen, mention_count, aliases, is_pinned)
      VALUES (?, ?, 'topic', ?, ?, 1, '[]', 0)
    `).run('stale-topic', 'stale-topic', oldDate, oldDate);

    mockComplete.mockResolvedValue('[]');

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true, pruneMinAgeDays: 30 };
    const result = await runEntityHygieneStep(root, config);

    expect(result.count).toBe(result.artifactsCleaned + result.merged + result.pruned);
  });

  it('errors is undefined when there are no errors', async () => {
    mockComplete.mockResolvedValue('[]');

    const config = { ...DEFAULT_CONFIG, enableEntityHygiene: true };
    const result = await runEntityHygieneStep(root, config);

    expect(result.errors).toBeUndefined();
  });
});
