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

// Mock fs.readFile
const mockReadFile = vi.fn();
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readFile: (...args: unknown[]) => mockReadFile(...args),
  };
});

const { getTimelineDb } = await import('../../timeline.js');
const { runTagStep } = await import('./tag.js');
const { DEFAULT_CONFIG } = await import('../config.js');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-tag-test-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function insertEvent(opts: {
  title: string;
  summary?: string;
  source_path?: string;
  tags_json?: string;
  topics_json?: string;
  last_enriched?: string | null;
  priority?: number;
}): Promise<number> {
  const db = await getTimelineDb(root);
  const result = db.prepare(`
    INSERT INTO timeline_events (type, timestamp, title, summary, source_path, priority, tags_json, topics_json, last_enriched)
    VALUES ('note', datetime('now'), ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.title,
    opts.summary || 'test summary with enough content to pass the 50 char minimum check here',
    opts.source_path || `test/${opts.title.replace(/\s/g, '-')}.md`,
    opts.priority ?? 0.5,
    opts.tags_json || '[]',
    opts.topics_json || '[]',
    opts.last_enriched ?? null,
  );
  return result.lastInsertRowid as number;
}

function getTags(id: number): string[] {
  const db = getTimelineDb(root) as any;
  // getTimelineDb is async but the db reference is cached, for reading we need a sync approach
  // Actually we need to await it
  return [];
}

beforeEach(async () => {
  mockComplete.mockReset();
  mockReadFile.mockReset();
  const db = await getTimelineDb(root);
  db.exec('DELETE FROM timeline_events');
});

describe('runTagStep', () => {
  it('should return count 0 when tagging is disabled', async () => {
    const config = { ...DEFAULT_CONFIG, enableTagging: false };
    const result = await runTagStep(root, config);
    expect(result.count).toBe(0);
    expect(result.errors).toBeUndefined();
  });

  it('should return count 0 when no items need tagging', async () => {
    // All items have recent last_enriched
    await insertEvent({
      title: 'Recently tagged',
      last_enriched: new Date().toISOString(),
      tags_json: '["existing"]',
    });

    const result = await runTagStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(0);
  });

  it('should tag items with null last_enriched', async () => {
    const id = await insertEvent({
      title: 'Untagged item',
      last_enriched: null,
    });

    mockReadFile.mockResolvedValue('This is a long enough content about Python programming and async patterns that passes the minimum length check.');
    mockComplete.mockResolvedValue('["python", "programming", "async"]');

    const result = await runTagStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(1);

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT tags_json FROM timeline_events WHERE id = ?').get(id) as { tags_json: string };
    const tags = JSON.parse(row.tags_json);
    expect(tags).toContain('python');
    expect(tags).toContain('programming');
    expect(tags).toContain('async');
  });

  it('should tag items with empty tags', async () => {
    const id = await insertEvent({
      title: 'Empty tags item',
      tags_json: '[]',
      last_enriched: null,
    });

    mockReadFile.mockResolvedValue('Content about deploying applications to Kubernetes with Docker containers in production environments.');
    mockComplete.mockResolvedValue('["kubernetes", "docker", "deployment"]');

    const result = await runTagStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(1);

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT tags_json FROM timeline_events WHERE id = ?').get(id) as { tags_json: string };
    const tags = JSON.parse(row.tags_json);
    expect(tags).toContain('kubernetes');
  });

  it('should merge new tags with existing topics', async () => {
    const id = await insertEvent({
      title: 'Has topics',
      topics_json: '["existing-topic", "another-topic"]',
      last_enriched: null,
    });

    mockReadFile.mockResolvedValue('A detailed discussion about machine learning and data science approaches to solving classification problems.');
    mockComplete.mockResolvedValue('["machine-learning", "existing-topic"]');

    const result = await runTagStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(1);

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT tags_json FROM timeline_events WHERE id = ?').get(id) as { tags_json: string };
    const tags = JSON.parse(row.tags_json);
    // Should have merged new + existing without duplicates
    expect(tags).toContain('machine-learning');
    expect(tags).toContain('existing-topic');
    expect(tags).toContain('another-topic');
    // Check no duplicates
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('should skip items with content shorter than 50 chars', async () => {
    await insertEvent({
      title: 'Short',
      summary: 'Short',
      last_enriched: null,
    });

    mockReadFile.mockResolvedValue('Too short');
    mockComplete.mockResolvedValue('["tag"]');

    const result = await runTagStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(0);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('should fall back to summary when file read fails', async () => {
    const id = await insertEvent({
      title: 'Unreadable file item',
      summary: 'This is a sufficiently long summary about the security audit findings and recommendations for improvement.',
      last_enriched: null,
    });

    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    mockComplete.mockResolvedValue('["security", "audit"]');

    const result = await runTagStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(1);
    expect(mockComplete).toHaveBeenCalled();
  });

  it('should handle markdown-wrapped JSON in Claude response', async () => {
    const id = await insertEvent({
      title: 'Markdown wrapped',
      last_enriched: null,
    });

    mockReadFile.mockResolvedValue('Content about infrastructure monitoring and alerting systems for production applications deployed on cloud platforms.');
    mockComplete.mockResolvedValue('```json\n["monitoring", "alerting", "infrastructure"]\n```');

    const result = await runTagStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(1);

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT tags_json FROM timeline_events WHERE id = ?').get(id) as { tags_json: string };
    const tags = JSON.parse(row.tags_json);
    expect(tags).toContain('monitoring');
  });

  it('should skip when Claude response has no JSON array', async () => {
    await insertEvent({
      title: 'Bad response',
      last_enriched: null,
    });

    mockReadFile.mockResolvedValue('Content about testing strategies and continuous integration pipelines for software development teams.');
    mockComplete.mockResolvedValue('I cannot generate tags for this content.');

    const result = await runTagStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(0);
  });

  it('should handle Claude API errors gracefully', async () => {
    await insertEvent({
      title: 'API error item',
      last_enriched: null,
    });

    mockReadFile.mockResolvedValue('This is content long enough to process for tagging in the sleep agent pipeline testing scenario.');
    mockComplete.mockRejectedValue(new Error('Rate limit exceeded'));

    const result = await runTagStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(0);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('should respect maxTagsPerRun limit', async () => {
    const config = { ...DEFAULT_CONFIG, maxTagsPerRun: 2 };

    for (let i = 0; i < 5; i++) {
      await insertEvent({
        title: `Batch tag item ${i}`,
        last_enriched: null,
      });
    }

    mockReadFile.mockResolvedValue('Sufficiently long content about various programming languages and their ecosystems for software development projects.');
    mockComplete.mockResolvedValue('["programming", "languages"]');

    const result = await runTagStep(root, config);
    // Should process at most 2 items
    expect(result.count).toBeLessThanOrEqual(2);
  });

  it('should lowercase all tags', async () => {
    const id = await insertEvent({
      title: 'Case test',
      last_enriched: null,
    });

    mockReadFile.mockResolvedValue('Content about JavaScript and TypeScript programming with React and Node.js frameworks and libraries.');
    mockComplete.mockResolvedValue('["JavaScript", "TypeScript", "React"]');

    await runTagStep(root, DEFAULT_CONFIG);

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT tags_json FROM timeline_events WHERE id = ?').get(id) as { tags_json: string };
    const tags = JSON.parse(row.tags_json);
    expect(tags.every((t: string) => t === t.toLowerCase())).toBe(true);
  });

  it('should truncate file content to 3000 chars', async () => {
    await insertEvent({
      title: 'Long content',
      last_enriched: null,
    });

    const longContent = 'A'.repeat(5000);
    mockReadFile.mockResolvedValue(longContent);
    mockComplete.mockResolvedValue('["content"]');

    await runTagStep(root, DEFAULT_CONFIG);

    // The prompt passed to Claude should have truncated content
    const callArg = mockComplete.mock.calls[0][0];
    expect(callArg.length).toBeLessThan(5000);
  });

  it('should update last_enriched timestamp', async () => {
    const id = await insertEvent({
      title: 'Enrichment time test',
      last_enriched: null,
    });

    mockReadFile.mockResolvedValue('Content about database migrations and schema management for PostgreSQL in production environments that need testing.');
    mockComplete.mockResolvedValue('["database", "migrations"]');

    await runTagStep(root, DEFAULT_CONFIG);

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT last_enriched FROM timeline_events WHERE id = ?').get(id) as { last_enriched: string | null };
    expect(row.last_enriched).not.toBeNull();
  });
});
