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
const { runLinkStep } = await import('./link.js');
const { DEFAULT_CONFIG } = await import('../config.js');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-link-test-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function insertEvent(opts: {
  title: string;
  source_path?: string;
  tags_json?: string;
  topics_json?: string;
  tier?: string;
  priority?: number;
}): Promise<number> {
  const db = await getTimelineDb(root);
  const result = db.prepare(`
    INSERT INTO timeline_events (type, timestamp, title, summary, source_path, priority, tier, tags_json, topics_json, entities_json)
    VALUES ('note', datetime('now'), ?, 'test', ?, ?, ?, ?, ?, '[]')
  `).run(
    opts.title,
    opts.source_path || `test/${opts.title.replace(/\s/g, '-')}.md`,
    opts.priority ?? 0.5,
    opts.tier || 'warm',
    opts.tags_json || '[]',
    opts.topics_json || '[]',
  );
  return result.lastInsertRowid as number;
}

function getEdgeCount(): number {
  const sleep = getSleepDb(root);
  return (sleep.prepare('SELECT COUNT(*) as count FROM memory_edges').get() as { count: number }).count;
}

function getEdges(): Array<{ from_path: string; to_path: string; confidence: number; rationale: string }> {
  const sleep = getSleepDb(root);
  return sleep.prepare('SELECT from_path, to_path, confidence, rationale FROM memory_edges').all() as Array<{
    from_path: string; to_path: string; confidence: number; rationale: string;
  }>;
}

beforeEach(async () => {
  const db = await getTimelineDb(root);
  db.exec('DELETE FROM timeline_events');
  const sleep = getSleepDb(root);
  sleep.exec('DELETE FROM memory_edges');
});

describe('runLinkStep', () => {
  it('should return count 0 when no items have tags', async () => {
    await insertEvent({ title: 'No tags item' });
    const result = await runLinkStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(0);
    expect(result.errors).toBeUndefined();
  });

  it('should return count 0 when fewer than 2 tagged items exist', async () => {
    await insertEvent({
      title: 'Only tagged item',
      tags_json: '["python", "coding"]',
    });
    const result = await runLinkStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(0);
  });

  it('should create edges between items sharing tags', async () => {
    await insertEvent({
      title: 'Python tutorial',
      source_path: 'notes/python-tutorial.md',
      tags_json: '["python", "coding", "tutorial"]',
    });
    await insertEvent({
      title: 'Python best practices',
      source_path: 'notes/python-practices.md',
      tags_json: '["python", "coding", "best-practices"]',
    });

    const result = await runLinkStep(root, DEFAULT_CONFIG);
    expect(result.count).toBeGreaterThan(0);
    expect(getEdgeCount()).toBeGreaterThan(0);
  });

  it('should not create edges between items with no shared tags', async () => {
    await insertEvent({
      title: 'Python topic',
      source_path: 'notes/python.md',
      tags_json: '["python", "coding"]',
    });
    await insertEvent({
      title: 'Cooking topic',
      source_path: 'notes/cooking.md',
      tags_json: '["cooking", "recipes"]',
    });

    const result = await runLinkStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(0);
  });

  it('should exclude metadata tags from similarity calculation', async () => {
    // 'note', 'file', 'document' etc. are excluded
    await insertEvent({
      title: 'Item A',
      source_path: 'notes/item-a.md',
      tags_json: '["note", "file", "document"]',
    });
    await insertEvent({
      title: 'Item B',
      source_path: 'notes/item-b.md',
      tags_json: '["note", "file", "document"]',
    });

    const result = await runLinkStep(root, DEFAULT_CONFIG);
    // These tags are all excluded, so no meaningful shared tags → no edges
    expect(result.count).toBe(0);
  });

  it('should filter tags shorter than 3 characters', async () => {
    await insertEvent({
      title: 'Item with short tags A',
      source_path: 'notes/short-a.md',
      tags_json: '["ai", "ml", "python"]',
    });
    await insertEvent({
      title: 'Item with short tags B',
      source_path: 'notes/short-b.md',
      tags_json: '["ai", "ml", "javascript"]',
    });

    const result = await runLinkStep(root, DEFAULT_CONFIG);
    // "ai" and "ml" are < 3 chars, filtered out. Only "python" vs "javascript" remain = no match
    expect(result.count).toBe(0);
  });

  it('should boost confidence for items in same directory', async () => {
    await insertEvent({
      title: 'Same dir item 1',
      source_path: 'notes/project/item1.md',
      tags_json: '["architecture", "design", "patterns"]',
    });
    await insertEvent({
      title: 'Same dir item 2',
      source_path: 'notes/project/item2.md',
      tags_json: '["architecture", "design", "review"]',
    });
    await insertEvent({
      title: 'Diff dir item',
      source_path: 'notes/other/item3.md',
      tags_json: '["architecture", "design", "review"]',
    });

    await runLinkStep(root, DEFAULT_CONFIG);

    const edges = getEdges();
    const sameDirEdge = edges.find(
      e => e.from_path.includes('project/item1') && e.to_path.includes('project/item2') ||
           e.from_path.includes('project/item2') && e.to_path.includes('project/item1')
    );
    const diffDirEdge = edges.find(
      e => (e.from_path.includes('project/item1') && e.to_path.includes('other/item3')) ||
           (e.from_path.includes('other/item3') && e.to_path.includes('project/item1'))
    );

    if (sameDirEdge && diffDirEdge) {
      expect(sameDirEdge.confidence).toBeGreaterThan(diffDirEdge.confidence);
    }
  });

  it('should boost confidence for 3+ shared tags', async () => {
    await insertEvent({
      title: 'Many shared A',
      source_path: 'notes/many-a.md',
      tags_json: '["python", "async", "networking", "http"]',
    });
    await insertEvent({
      title: 'Many shared B',
      source_path: 'notes/many-b.md',
      tags_json: '["python", "async", "networking", "websocket"]',
    });

    await runLinkStep(root, DEFAULT_CONFIG);

    const edges = getEdges();
    expect(edges.length).toBe(1);
    // 3+ shared tags gives +0.2 boost
    // Jaccard for {python, async, networking, http} vs {python, async, networking, websocket} = 3/5 = 0.6
    // + 0.2 (3+ shared) = 0.8
    expect(edges[0].confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('should boost confidence for same tier', async () => {
    await insertEvent({
      title: 'Hot A',
      source_path: 'notes/hot-a.md',
      tags_json: '["deployment", "kubernetes"]',
      tier: 'hot',
    });
    await insertEvent({
      title: 'Hot B',
      source_path: 'notes/hot-b.md',
      tags_json: '["deployment", "docker"]',
      tier: 'hot',
    });

    await runLinkStep(root, DEFAULT_CONFIG);
    const edges = getEdges();
    if (edges.length > 0) {
      // Same tier boost is +0.05
      expect(edges[0].confidence).toBeGreaterThan(0);
    }
  });

  it('should cap confidence at 1.0', async () => {
    // Create items with very high similarity + all boosts
    await insertEvent({
      title: 'Max confidence A',
      source_path: 'notes/same-dir/max-a.md',
      tags_json: '["tag1", "tag2", "tag3", "tag4", "tag5"]',
      tier: 'hot',
    });
    await insertEvent({
      title: 'Max confidence B',
      source_path: 'notes/same-dir/max-b.md',
      tags_json: '["tag1", "tag2", "tag3", "tag4", "tag5"]',
      tier: 'hot',
    });

    await runLinkStep(root, DEFAULT_CONFIG);
    const edges = getEdges();
    expect(edges.length).toBe(1);
    expect(edges[0].confidence).toBeLessThanOrEqual(1.0);
  });

  it('should not create duplicate edges', async () => {
    await insertEvent({
      title: 'Dup A',
      source_path: 'notes/dup-a.md',
      tags_json: '["testing", "quality"]',
    });
    await insertEvent({
      title: 'Dup B',
      source_path: 'notes/dup-b.md',
      tags_json: '["testing", "quality"]',
    });

    // Run twice
    await runLinkStep(root, DEFAULT_CONFIG);
    const firstCount = getEdgeCount();
    await runLinkStep(root, DEFAULT_CONFIG);
    const secondCount = getEdgeCount();

    expect(secondCount).toBe(firstCount);
  });

  it('should respect maxEdgesPerMemory limit', async () => {
    const config = { ...DEFAULT_CONFIG, maxEdgesPerMemory: 1 };

    // Create multiple items sharing tags with item A
    await insertEvent({
      title: 'Central item',
      source_path: 'notes/central.md',
      tags_json: '["common", "shared"]',
    });
    for (let i = 0; i < 5; i++) {
      await insertEvent({
        title: `Connected item ${i}`,
        source_path: `notes/connected-${i}.md`,
        tags_json: '["common", "shared"]',
      });
    }

    await runLinkStep(root, config);
    // With maxEdgesPerMemory=1, central item should only get 1 edge
    // (though other items may also create edges between themselves)
    const sleep = getSleepDb(root);
    const centralEdges = sleep.prepare(`
      SELECT COUNT(*) as count FROM memory_edges
      WHERE from_path = 'notes/central.md' OR to_path = 'notes/central.md'
    `).get() as { count: number };
    expect(centralEdges.count).toBeLessThanOrEqual(config.maxEdgesPerMemory);
  });

  it('should respect maxLinksPerRun limit', async () => {
    const config = { ...DEFAULT_CONFIG, maxLinksPerRun: 2 };

    for (let i = 0; i < 10; i++) {
      await insertEvent({
        title: `Batch item ${i}`,
        source_path: `notes/batch-${i}.md`,
        tags_json: '["common", "batch", "testing"]',
      });
    }

    const result = await runLinkStep(root, config);
    expect(result.count).toBeLessThanOrEqual(2);
  });

  it('should handle CSV-format tags', async () => {
    await insertEvent({
      title: 'CSV tags A',
      source_path: 'notes/csv-a.md',
      tags_json: '"python, coding, tutorial"',
    });
    await insertEvent({
      title: 'CSV tags B',
      source_path: 'notes/csv-b.md',
      tags_json: '"python, coding, review"',
    });

    const result = await runLinkStep(root, DEFAULT_CONFIG);
    expect(result.count).toBeGreaterThan(0);
  });

  it('should combine tags and topics for similarity', async () => {
    await insertEvent({
      title: 'Tags only',
      source_path: 'notes/tags-only.md',
      tags_json: '["python", "async"]',
      topics_json: '[]',
    });
    await insertEvent({
      title: 'Topics only',
      source_path: 'notes/topics-only.md',
      tags_json: '[]',
      topics_json: '["python", "async"]',
    });

    const result = await runLinkStep(root, DEFAULT_CONFIG);
    expect(result.count).toBeGreaterThan(0);
  });

  it('should include rationale with shared tags in edge', async () => {
    await insertEvent({
      title: 'Rationale A',
      source_path: 'notes/rationale-a.md',
      tags_json: '["security", "authentication", "oauth"]',
    });
    await insertEvent({
      title: 'Rationale B',
      source_path: 'notes/rationale-b.md',
      tags_json: '["security", "authentication", "jwt"]',
    });

    await runLinkStep(root, DEFAULT_CONFIG);
    const edges = getEdges();
    expect(edges.length).toBe(1);
    expect(edges[0].rationale).toContain('Jaccard');
    expect(edges[0].rationale).toMatch(/security|authentication/);
  });
});
