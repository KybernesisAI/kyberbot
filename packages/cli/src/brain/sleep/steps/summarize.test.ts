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
const { getSleepDb } = await import('../db.js');
const { runSummarizeStep } = await import('./summarize.js');
const { DEFAULT_CONFIG } = await import('../config.js');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-summarize-test-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function insertEvent(opts: {
  title: string;
  summary?: string | null;
  source_path?: string;
  tier?: string;
  tags_json?: string;
  entities_json?: string;
  priority?: number;
}): Promise<number> {
  const db = await getTimelineDb(root);
  const result = db.prepare(`
    INSERT INTO timeline_events (type, timestamp, title, summary, source_path, priority, tier, tags_json, entities_json)
    VALUES ('note', datetime('now'), ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.title,
    opts.summary ?? null,
    opts.source_path || `test/${opts.title.replace(/\s/g, '-')}.md`,
    opts.priority ?? 0.5,
    opts.tier || 'warm',
    opts.tags_json || '[]',
    opts.entities_json || '[]',
  );
  return result.lastInsertRowid as number;
}

function addToQueue(itemId: number): number {
  const sleep = getSleepDb(root);
  const result = sleep.prepare(`
    INSERT INTO maintenance_queue (item_type, item_id, task, priority)
    VALUES ('timeline', ?, 'resummarize', 5)
  `).run(itemId.toString());
  return result.lastInsertRowid as number;
}

function isQueueProcessed(queueId: number): boolean {
  const sleep = getSleepDb(root);
  const row = sleep.prepare('SELECT processed_at FROM maintenance_queue WHERE id = ?').get(queueId) as { processed_at: string | null } | undefined;
  return row?.processed_at !== null;
}

beforeEach(async () => {
  mockComplete.mockReset();
  mockReadFile.mockReset();
  const db = await getTimelineDb(root);
  db.exec('DELETE FROM timeline_events');
  const sleep = getSleepDb(root);
  sleep.exec('DELETE FROM maintenance_queue');
  sleep.exec('DELETE FROM memory_edges');
});

describe('runSummarizeStep', () => {
  it('should return count 0 when no items need summarization', async () => {
    await insertEvent({
      title: 'Well summarized item',
      summary: 'A good summary that is between 50 and 500 characters and does not start with JSON or markdown.',
    });

    const result = await runSummarizeStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(0);
    expect(result.errors).toBeUndefined();
  });

  it('should summarize items with null summary', async () => {
    const id = await insertEvent({
      title: 'No summary item',
      summary: null,
    });

    mockReadFile.mockResolvedValue('This is a detailed document about the architecture of our microservices system. It covers service boundaries, communication patterns, and deployment strategies.');
    mockComplete.mockResolvedValue('The document covered microservices architecture including service boundaries, communication patterns, and deployment strategies.');

    const result = await runSummarizeStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(1);
    expect(result.durationMs).toBeDefined();

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT summary FROM timeline_events WHERE id = ?').get(id) as { summary: string };
    expect(row.summary).toContain('microservices');
  });

  it('should summarize items with very short summary', async () => {
    const id = await insertEvent({
      title: 'Short summary item',
      summary: 'Brief',
    });

    mockReadFile.mockResolvedValue('Comprehensive guide to implementing OAuth 2.0 authentication flows in Node.js applications with Express middleware integration.');
    mockComplete.mockResolvedValue('A comprehensive guide covered OAuth 2.0 authentication implementation in Node.js with Express middleware.');

    const result = await runSummarizeStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(1);
  });

  it('should summarize items with JSON blob as summary', async () => {
    await insertEvent({
      title: 'JSON summary item',
      summary: '{"key": "value", "data": [1, 2, 3]}',
    });

    mockReadFile.mockResolvedValue('Meeting notes from the team sync discussing project timelines, resource allocation, and the upcoming product launch event.');
    mockComplete.mockResolvedValue('Team sync meeting discussed project timelines, resource allocation, and upcoming product launch planning.');

    const result = await runSummarizeStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(1);
  });

  it('should summarize items with markdown as summary', async () => {
    await insertEvent({
      title: 'Markdown summary item',
      summary: '# Full Markdown Document\n\nThis is the entire file content stored as a summary...',
    });

    mockReadFile.mockResolvedValue('# Full Markdown Document\n\nThis document describes the API design for the new payment service integration with Stripe.');
    mockComplete.mockResolvedValue('The API design document outlined the payment service integration with Stripe including endpoint specifications.');

    const result = await runSummarizeStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(1);
  });

  it('should summarize items with overly long summary', async () => {
    await insertEvent({
      title: 'Long summary item',
      summary: 'A'.repeat(600),
    });

    mockReadFile.mockResolvedValue('Technical specification for the real-time notification system including WebSocket implementation, message queuing, and delivery guarantees.');
    mockComplete.mockResolvedValue('Technical spec detailed real-time notification system with WebSocket implementation and message delivery guarantees.');

    const result = await runSummarizeStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(1);
  });

  it('should process maintenance queue items first', async () => {
    const id = await insertEvent({
      title: 'Queued item',
      summary: 'Has an existing summary that is adequate and between limits',
    });
    const queueId = addToQueue(id);

    mockReadFile.mockResolvedValue('Updated content about the infrastructure migration from AWS to GCP including cost analysis, timeline, and risk assessment.');
    mockComplete.mockResolvedValue('Infrastructure migration plan from AWS to GCP covered cost analysis, timeline, and risk mitigation strategies.');

    const result = await runSummarizeStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(1);
    expect(isQueueProcessed(queueId)).toBe(true);
  });

  it('should strip Claude preambles from summary', async () => {
    const id = await insertEvent({
      title: 'Preamble test',
      summary: null,
    });

    mockReadFile.mockResolvedValue('Discussion about implementing rate limiting across all API endpoints using a Redis-backed token bucket algorithm.');
    mockComplete.mockResolvedValue("Here's a concise summary: Rate limiting was implemented across API endpoints using Redis-backed token bucket algorithm.");

    const result = await runSummarizeStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(1);

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT summary FROM timeline_events WHERE id = ?').get(id) as { summary: string };
    expect(row.summary).not.toMatch(/^Here's/);
    expect(row.summary).toContain('Rate limiting');
  });

  it('should skip items with content shorter than 50 chars', async () => {
    await insertEvent({
      title: 'Short content',
      summary: null,
    });

    mockReadFile.mockResolvedValue('Too short');

    const result = await runSummarizeStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(0);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('should skip items when file is unreadable and mark queue', async () => {
    const id = await insertEvent({
      title: 'Missing file',
      summary: null,
    });
    const queueId = addToQueue(id);

    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

    const result = await runSummarizeStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(0);
    expect(isQueueProcessed(queueId)).toBe(true);
  });

  it('should reject summaries shorter than 20 chars', async () => {
    const id = await insertEvent({
      title: 'Terse response',
      summary: null,
    });

    mockReadFile.mockResolvedValue('A lengthy document about database optimization techniques including indexing strategies and query planning.');
    mockComplete.mockResolvedValue('Short.');

    const result = await runSummarizeStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(0);

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT summary FROM timeline_events WHERE id = ?').get(id) as { summary: string | null };
    expect(row.summary).toBeNull();
  });

  it('should strip frontmatter from file content', async () => {
    const id = await insertEvent({
      title: 'Frontmatter test',
      summary: null,
    });

    mockReadFile.mockResolvedValue('---\ntitle: Test\ndate: 2025-01-01\n---\n\nActual content about the security incident response plan and procedures for handling data breaches.');
    mockComplete.mockResolvedValue('The security incident response plan outlined procedures for handling data breaches effectively.');

    await runSummarizeStep(root, DEFAULT_CONFIG);
    // Verify Claude received content without frontmatter
    const prompt = mockComplete.mock.calls[0][0];
    expect(prompt).not.toContain('title: Test');
    expect(prompt).toContain('security incident');
  });

  it('should include related memory titles in prompt context', async () => {
    const id = await insertEvent({
      title: 'With relations',
      summary: null,
      source_path: 'notes/with-relations.md',
    });
    await insertEvent({
      title: 'Related Security Doc',
      summary: 'Related document',
      source_path: 'notes/related-security.md',
    });

    // Create edge
    const sleep = getSleepDb(root);
    sleep.prepare(`
      INSERT INTO memory_edges (from_path, to_path, relation, confidence, created_at, last_verified)
      VALUES (?, ?, 'related', 0.8, datetime('now'), datetime('now'))
    `).run('notes/with-relations.md', 'notes/related-security.md');

    mockReadFile.mockResolvedValue('Content about implementing zero-trust security architecture with identity verification at every boundary.');
    mockComplete.mockResolvedValue('Zero-trust security architecture was implemented with identity verification at every network boundary.');

    await runSummarizeStep(root, DEFAULT_CONFIG);
    const prompt = mockComplete.mock.calls[0][0];
    expect(prompt).toContain('Related Security Doc');
  });

  it('should use tier-appropriate prompts', async () => {
    // Hot tier
    await insertEvent({ title: 'Hot item', summary: null, tier: 'hot', source_path: 'notes/hot.md' });
    mockReadFile.mockResolvedValue('Critical production incident analysis and root cause investigation for the authentication service outage.');
    mockComplete.mockResolvedValue('Critical production incident involving auth service outage was analyzed with root cause identified.');

    await runSummarizeStep(root, DEFAULT_CONFIG);
    let prompt = mockComplete.mock.calls[0][0];
    expect(prompt).toContain('HIGH-PRIORITY');

    // Reset for archive
    mockComplete.mockReset();
    mockReadFile.mockReset();
    const db = await getTimelineDb(root);
    db.exec('DELETE FROM timeline_events');

    await insertEvent({ title: 'Archive item', summary: null, tier: 'archive', source_path: 'notes/archive.md' });
    mockReadFile.mockResolvedValue('Old documentation about deprecated API version 1 endpoints that are no longer in use by any client applications.');
    mockComplete.mockResolvedValue('Deprecated API v1 documentation covering endpoints no longer used by clients.');

    await runSummarizeStep(root, DEFAULT_CONFIG);
    prompt = mockComplete.mock.calls[0][0];
    expect(prompt).toContain('ARCHIVED');
    expect(prompt).toContain('ultra-concise');
  });

  it('should handle Claude API errors with error tracking', async () => {
    await insertEvent({
      title: 'API failure item',
      summary: null,
    });

    mockReadFile.mockResolvedValue('Content about implementing distributed tracing with OpenTelemetry across microservices for observability.');
    mockComplete.mockRejectedValue(new Error('Service unavailable'));

    const result = await runSummarizeStep(root, DEFAULT_CONFIG);
    expect(result.count).toBe(0);
    expect(result.errors).toBeDefined();
    expect(result.errors![0]).toContain('Service unavailable');
  });

  it('should respect maxSummariesPerRun limit', async () => {
    const config = { ...DEFAULT_CONFIG, maxSummariesPerRun: 2 };

    for (let i = 0; i < 5; i++) {
      await insertEvent({
        title: `Batch summarize ${i}`,
        summary: null,
      });
    }

    mockReadFile.mockResolvedValue('Detailed content about software architecture patterns and their applications in modern distributed systems.');
    mockComplete.mockResolvedValue('Software architecture patterns and their applications in distributed systems were discussed.');

    const result = await runSummarizeStep(root, config);
    expect(result.count).toBeLessThanOrEqual(2);
  });

  it('should limit file content to 4000 chars', async () => {
    await insertEvent({
      title: 'Long file',
      summary: null,
    });

    const longContent = 'Word '.repeat(2000); // ~10000 chars
    mockReadFile.mockResolvedValue(longContent);
    mockComplete.mockResolvedValue('Long document was summarized covering extensive content about various topics.');

    await runSummarizeStep(root, DEFAULT_CONFIG);
    const prompt = mockComplete.mock.calls[0][0];
    // The content portion should be truncated
    expect(prompt.length).toBeLessThan(longContent.length);
  });

  it('should update last_enriched on successful summarization', async () => {
    const id = await insertEvent({
      title: 'Enrichment update test',
      summary: null,
    });

    mockReadFile.mockResolvedValue('Documentation about CI/CD pipeline configuration using GitHub Actions with automated testing and deployment stages.');
    mockComplete.mockResolvedValue('CI/CD pipeline documentation covered GitHub Actions configuration with automated testing and deployment.');

    await runSummarizeStep(root, DEFAULT_CONFIG);

    const db = await getTimelineDb(root);
    const row = db.prepare('SELECT last_enriched FROM timeline_events WHERE id = ?').get(id) as { last_enriched: string | null };
    expect(row.last_enriched).not.toBeNull();
  });

  it('should record error in queue on failure', async () => {
    const id = await insertEvent({
      title: 'Queue error test',
      summary: null,
    });
    const queueId = addToQueue(id);

    mockReadFile.mockResolvedValue('Content about implementing event sourcing patterns in Node.js applications for audit trailing and state reconstruction.');
    mockComplete.mockRejectedValue(new Error('Timeout'));

    await runSummarizeStep(root, DEFAULT_CONFIG);

    const sleep = getSleepDb(root);
    const row = sleep.prepare('SELECT error_message, processed_at FROM maintenance_queue WHERE id = ?').get(queueId) as {
      error_message: string | null;
      processed_at: string | null;
    };
    expect(row.processed_at).not.toBeNull();
    expect(row.error_message).toContain('Timeout');
  });

  it('should include tags and entities in prompt context', async () => {
    await insertEvent({
      title: 'Context rich item',
      summary: null,
      tags_json: '["security", "auth"]',
      entities_json: '["Alice", "Bob"]',
    });

    mockReadFile.mockResolvedValue('Security review meeting with the team to discuss authentication improvements and authorization policy changes.');
    mockComplete.mockResolvedValue('Security review meeting discussed authentication improvements and authorization policy changes.');

    await runSummarizeStep(root, DEFAULT_CONFIG);
    const prompt = mockComplete.mock.calls[0][0];
    expect(prompt).toContain('security');
    expect(prompt).toContain('Alice');
  });
});
