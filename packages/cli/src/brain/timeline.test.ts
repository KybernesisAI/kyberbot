import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock logger to suppress output during tests
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const {
  addToTimeline,
  removeFromTimeline,
  queryTimeline,
  getRecentActivity,
  getActivityOnDate,
  getActivityInRange,
  searchTimeline,
  getEventByPath,
  getTimelineStats,
  addConversationToTimeline,
  addIdeaToTimeline,
} = await import('./timeline.js');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-timeline-test-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('addToTimeline', () => {
  it('should add an event and return its id', async () => {
    const id = await addToTimeline(root, {
      type: 'conversation',
      timestamp: '2025-01-15T10:00:00Z',
      title: 'Test Conversation',
      summary: 'A test conversation about testing',
      source_path: '/test/conv-1',
      entities: ['Alice', 'Bob'],
      topics: ['testing', 'vitest'],
    });

    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('should upsert on duplicate source_path', async () => {
    const id1 = await addToTimeline(root, {
      type: 'note',
      timestamp: '2025-01-15T11:00:00Z',
      title: 'Original',
      summary: 'original content',
      source_path: '/test/upsert',
      entities: [],
      topics: [],
    });

    const id2 = await addToTimeline(root, {
      type: 'note',
      timestamp: '2025-01-15T12:00:00Z',
      title: 'Updated',
      summary: 'updated content',
      source_path: '/test/upsert',
      entities: [],
      topics: [],
    });

    const event = await getEventByPath(root, '/test/upsert');
    expect(event).not.toBeNull();
    expect(event!.title).toBe('Updated');
  });

  it('should handle all event types', async () => {
    const types = ['conversation', 'idea', 'file', 'transcript', 'note', 'intake'] as const;

    for (const type of types) {
      const id = await addToTimeline(root, {
        type,
        timestamp: '2025-01-15T10:00:00Z',
        title: `${type} event`,
        summary: `A ${type}`,
        source_path: `/test/type-${type}`,
        entities: [],
        topics: [],
      });
      expect(id).toBeGreaterThan(0);
    }
  });
});

describe('removeFromTimeline', () => {
  it('should remove an existing event', async () => {
    await addToTimeline(root, {
      type: 'note',
      timestamp: '2025-01-15T10:00:00Z',
      title: 'To Remove',
      summary: '',
      source_path: '/test/to-remove',
      entities: [],
      topics: [],
    });

    const removed = await removeFromTimeline(root, '/test/to-remove');
    expect(removed).toBe(true);

    const event = await getEventByPath(root, '/test/to-remove');
    expect(event).toBeNull();
  });

  it('should return false for non-existent path', async () => {
    const removed = await removeFromTimeline(root, '/test/does-not-exist');
    expect(removed).toBe(false);
  });
});

describe('queryTimeline', () => {
  it('should return all events with no filters', async () => {
    const events = await queryTimeline(root);
    expect(events.length).toBeGreaterThan(0);
  });

  it('should filter by type', async () => {
    const events = await queryTimeline(root, { type: 'conversation' });
    expect(events.every(e => e.type === 'conversation')).toBe(true);
  });

  it('should filter by date range', async () => {
    await addToTimeline(root, {
      type: 'note',
      timestamp: '2025-02-01T10:00:00Z',
      title: 'February Note',
      summary: '',
      source_path: '/test/feb-note',
      entities: [],
      topics: [],
    });

    const events = await queryTimeline(root, {
      start: '2025-02-01T00:00:00Z',
      end: '2025-02-28T23:59:59Z',
    });

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.timestamp >= '2025-02-01T00:00:00Z').toBe(true);
    }
  });

  it('should support full-text search', async () => {
    await addToTimeline(root, {
      type: 'note',
      timestamp: '2025-01-20T10:00:00Z',
      title: 'Kubernetes Deployment',
      summary: 'Deployed the app to kubernetes cluster',
      source_path: '/test/k8s-deploy',
      entities: [],
      topics: ['kubernetes'],
    });

    const events = await queryTimeline(root, { search: 'kubernetes' });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.title.includes('Kubernetes'))).toBe(true);
  });

  it('should respect limit and offset', async () => {
    const all = await queryTimeline(root, { limit: 100 });
    const limited = await queryTimeline(root, { limit: 2 });
    const offset = await queryTimeline(root, { limit: 2, offset: 2 });

    expect(limited.length).toBeLessThanOrEqual(2);
    if (all.length > 2) {
      expect(offset[0]?.id).not.toBe(limited[0]?.id);
    }
  });

  it('should parse entities from JSON', async () => {
    const events = await queryTimeline(root, { type: 'conversation' });
    for (const e of events) {
      expect(Array.isArray(e.entities)).toBe(true);
      expect(Array.isArray(e.topics)).toBe(true);
    }
  });
});

describe('getRecentActivity', () => {
  it('should return events sorted by timestamp desc', async () => {
    const events = await getRecentActivity(root, 10);
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].timestamp >= events[i].timestamp).toBe(true);
    }
  });
});

describe('getActivityOnDate', () => {
  it('should return events for a specific date', async () => {
    const events = await getActivityOnDate(root, '2025-01-15');
    for (const e of events) {
      expect(e.timestamp.startsWith('2025-01-15')).toBe(true);
    }
  });
});

describe('getActivityInRange', () => {
  it('should return events within range', async () => {
    const events = await getActivityInRange(root, '2025-01-01T00:00:00Z', '2025-01-31T23:59:59Z');
    for (const e of events) {
      expect(e.timestamp >= '2025-01-01T00:00:00Z').toBe(true);
      expect(e.timestamp <= '2025-01-31T23:59:59Z').toBe(true);
    }
  });
});

describe('searchTimeline', () => {
  it('should search by text', async () => {
    const events = await searchTimeline(root, 'testing');
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('getEventByPath', () => {
  it('should return event by source path', async () => {
    const event = await getEventByPath(root, '/test/conv-1');
    expect(event).not.toBeNull();
    expect(event!.title).toBe('Test Conversation');
  });

  it('should return null for unknown path', async () => {
    const event = await getEventByPath(root, '/nonexistent');
    expect(event).toBeNull();
  });
});

describe('getTimelineStats', () => {
  it('should return statistics', async () => {
    const stats = await getTimelineStats(root);
    expect(stats.total_events).toBeGreaterThan(0);
    expect(stats.by_type).toHaveProperty('conversation');
    expect(stats.by_type).toHaveProperty('note');
    expect(stats.date_range.earliest).not.toBeNull();
    expect(stats.date_range.latest).not.toBeNull();
  });
});

describe('addConversationToTimeline', () => {
  it('should add a conversation event', async () => {
    const id = await addConversationToTimeline(
      root, 'conv-helper', '/test/conv-helper',
      '2025-01-20T09:00:00Z', '2025-01-20T09:30:00Z',
      'Helper Test', 'Testing the helper function',
      ['TestEntity'], ['helpers']
    );
    expect(id).toBeGreaterThan(0);

    const event = await getEventByPath(root, '/test/conv-helper');
    expect(event!.type).toBe('conversation');
    expect(event!.end_timestamp).toBe('2025-01-20T09:30:00Z');
  });
});

describe('addIdeaToTimeline', () => {
  it('should add an idea event', async () => {
    const id = await addIdeaToTimeline(
      root, 'idea-1', '/test/idea-1',
      '2025-01-20T10:00:00Z',
      'Great Idea', 'Build something cool',
      ['innovation', 'ai']
    );
    expect(id).toBeGreaterThan(0);

    const event = await getEventByPath(root, '/test/idea-1');
    expect(event!.type).toBe('idea');
    expect(event!.topics).toContain('innovation');
  });
});
