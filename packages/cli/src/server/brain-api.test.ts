import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock logger
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock config
vi.mock('../config.js', () => ({
  getRoot: () => '/tmp/test-brain-root',
}));

// Mock entity-graph
const mockSearchEntities = vi.fn();
const mockGetEntityContext = vi.fn();
const mockGetEntityGraphStats = vi.fn();
vi.mock('../brain/entity-graph.js', () => ({
  searchEntities: (...args: unknown[]) => mockSearchEntities(...args),
  getEntityContext: (...args: unknown[]) => mockGetEntityContext(...args),
  getEntityGraphStats: (...args: unknown[]) => mockGetEntityGraphStats(...args),
}));

// Mock timeline
const mockQueryTimeline = vi.fn();
const mockGetTimelineStats = vi.fn();
vi.mock('../brain/timeline.js', () => ({
  queryTimeline: (...args: unknown[]) => mockQueryTimeline(...args),
  getTimelineStats: (...args: unknown[]) => mockGetTimelineStats(...args),
}));

// Mock hybrid-search
const mockHybridSearch = vi.fn();
vi.mock('../brain/hybrid-search.js', () => ({
  hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
}));

const { createBrainRouter } = await import('./brain-api.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/', createBrainRouter());
  return app;
}

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  app = createTestApp();
});

describe('GET /health', () => {
  it('should return ok status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });
});

describe('GET /entities', () => {
  it('should search entities with query', async () => {
    mockSearchEntities.mockResolvedValue([
      { id: 1, name: 'Alice', type: 'person' },
    ]);

    const res = await request(app).get('/entities?q=alice');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(mockSearchEntities).toHaveBeenCalledWith('/tmp/test-brain-root', 'alice', expect.objectContaining({ limit: 20 }));
  });

  it('should use default query when none provided', async () => {
    mockSearchEntities.mockResolvedValue([]);

    const res = await request(app).get('/entities');
    expect(res.status).toBe(200);
    expect(mockSearchEntities).toHaveBeenCalledWith('/tmp/test-brain-root', '', expect.any(Object));
  });

  it('should cap limit at 500', async () => {
    mockSearchEntities.mockResolvedValue([]);

    await request(app).get('/entities?limit=1000');
    expect(mockSearchEntities).toHaveBeenCalledWith(
      '/tmp/test-brain-root',
      '',
      expect.objectContaining({ limit: 500 })
    );
  });

  it('should pass type filter', async () => {
    mockSearchEntities.mockResolvedValue([]);

    await request(app).get('/entities?type=person');
    expect(mockSearchEntities).toHaveBeenCalledWith(
      '/tmp/test-brain-root',
      '',
      expect.objectContaining({ type: 'person' })
    );
  });

  it('should return 500 on error', async () => {
    mockSearchEntities.mockRejectedValue(new Error('DB error'));

    const res = await request(app).get('/entities?q=test');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Search failed');
  });
});

describe('GET /entities/:nameOrId', () => {
  it('should get entity by name', async () => {
    mockGetEntityContext.mockResolvedValue({
      entity: { name: 'Alice', type: 'person' },
      mentions: [],
    });

    const res = await request(app).get('/entities/Alice');
    expect(res.status).toBe(200);
    expect(mockGetEntityContext).toHaveBeenCalledWith('/tmp/test-brain-root', 'Alice');
  });

  it('should get entity by numeric ID', async () => {
    mockGetEntityContext.mockResolvedValue({
      entity: { id: 42, name: 'Alice' },
    });

    const res = await request(app).get('/entities/42');
    expect(res.status).toBe(200);
    expect(mockGetEntityContext).toHaveBeenCalledWith('/tmp/test-brain-root', 42);
  });

  it('should return 404 when entity not found', async () => {
    mockGetEntityContext.mockResolvedValue(null);

    const res = await request(app).get('/entities/nobody');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Entity not found');
  });

  it('should return 500 on error', async () => {
    mockGetEntityContext.mockRejectedValue(new Error('DB error'));

    const res = await request(app).get('/entities/Alice');
    expect(res.status).toBe(500);
  });
});

describe('GET /entities-stats', () => {
  it('should return entity graph statistics', async () => {
    mockGetEntityGraphStats.mockResolvedValue({
      totalEntities: 50,
      byType: { person: 30, company: 20 },
    });

    const res = await request(app).get('/entities-stats');
    expect(res.status).toBe(200);
    expect(res.body.totalEntities).toBe(50);
  });

  it('should return 500 on error', async () => {
    mockGetEntityGraphStats.mockRejectedValue(new Error('Stats failed'));

    const res = await request(app).get('/entities-stats');
    expect(res.status).toBe(500);
  });
});

describe('GET /timeline', () => {
  it('should query timeline events', async () => {
    mockQueryTimeline.mockResolvedValue([
      { id: 1, title: 'Event 1', timestamp: '2025-01-01' },
    ]);

    const res = await request(app).get('/timeline?q=test');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
  });

  it('should pass query parameters', async () => {
    mockQueryTimeline.mockResolvedValue([]);

    await request(app).get('/timeline?start=2025-01-01&end=2025-12-31&type=note&q=search&limit=10');
    expect(mockQueryTimeline).toHaveBeenCalledWith('/tmp/test-brain-root', {
      start: '2025-01-01',
      end: '2025-12-31',
      type: 'note',
      search: 'search',
      limit: 10,
    });
  });

  it('should cap limit at 500', async () => {
    mockQueryTimeline.mockResolvedValue([]);

    await request(app).get('/timeline?limit=1000');
    expect(mockQueryTimeline).toHaveBeenCalledWith(
      '/tmp/test-brain-root',
      expect.objectContaining({ limit: 500 })
    );
  });

  it('should default limit to 50', async () => {
    mockQueryTimeline.mockResolvedValue([]);

    await request(app).get('/timeline');
    expect(mockQueryTimeline).toHaveBeenCalledWith(
      '/tmp/test-brain-root',
      expect.objectContaining({ limit: 50 })
    );
  });

  it('should return 500 on error', async () => {
    mockQueryTimeline.mockRejectedValue(new Error('Query failed'));

    const res = await request(app).get('/timeline');
    expect(res.status).toBe(500);
  });
});

describe('GET /timeline-stats', () => {
  it('should return timeline statistics', async () => {
    mockGetTimelineStats.mockResolvedValue({
      totalEvents: 100,
      byType: { note: 50, conversation: 50 },
    });

    const res = await request(app).get('/timeline-stats');
    expect(res.status).toBe(200);
    expect(res.body.totalEvents).toBe(100);
  });

  it('should return 500 on error', async () => {
    mockGetTimelineStats.mockRejectedValue(new Error('Stats failed'));

    const res = await request(app).get('/timeline-stats');
    expect(res.status).toBe(500);
  });
});

describe('POST /search', () => {
  it('should perform hybrid search', async () => {
    mockHybridSearch.mockResolvedValue([
      {
        id: '1',
        title: 'Result 1',
        content: 'Test content',
        hybridScore: 0.9,
      },
    ]);

    const res = await request(app)
      .post('/search')
      .send({ query: 'test search' });

    expect(res.status).toBe(200);
    expect(res.body.query).toBe('test search');
    expect(res.body.results).toHaveLength(1);
  });

  it('should return 400 when query is missing', async () => {
    const res = await request(app)
      .post('/search')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Query required');
  });

  it('should pass search options', async () => {
    mockHybridSearch.mockResolvedValue([]);

    await request(app)
      .post('/search')
      .send({
        query: 'test',
        limit: '10',
        tier: 'hot',
        minPriority: '0.5',
      });

    expect(mockHybridSearch).toHaveBeenCalledWith(
      'test',
      '/tmp/test-brain-root',
      expect.objectContaining({
        limit: 10,
        tier: 'hot',
        minPriority: 0.5,
      })
    );
  });

  it('should cap limit at 500', async () => {
    mockHybridSearch.mockResolvedValue([]);

    await request(app)
      .post('/search')
      .send({ query: 'test', limit: '1000' });

    expect(mockHybridSearch).toHaveBeenCalledWith(
      'test',
      '/tmp/test-brain-root',
      expect.objectContaining({ limit: 500 })
    );
  });

  it('should default tier to all', async () => {
    mockHybridSearch.mockResolvedValue([]);

    await request(app)
      .post('/search')
      .send({ query: 'test' });

    expect(mockHybridSearch).toHaveBeenCalledWith(
      'test',
      '/tmp/test-brain-root',
      expect.objectContaining({ tier: 'all' })
    );
  });

  it('should default minPriority to 0', async () => {
    mockHybridSearch.mockResolvedValue([]);

    await request(app)
      .post('/search')
      .send({ query: 'test' });

    expect(mockHybridSearch).toHaveBeenCalledWith(
      'test',
      '/tmp/test-brain-root',
      expect.objectContaining({ minPriority: 0 })
    );
  });

  it('should return 500 on search error', async () => {
    mockHybridSearch.mockRejectedValue(new Error('Search failed'));

    const res = await request(app)
      .post('/search')
      .send({ query: 'test' });
    expect(res.status).toBe(500);
  });

  it('should handle invalid limit gracefully', async () => {
    mockHybridSearch.mockResolvedValue([]);

    await request(app)
      .post('/search')
      .send({ query: 'test', limit: 'abc' });

    // parseInt('abc') = NaN, || 20 fallback
    expect(mockHybridSearch).toHaveBeenCalledWith(
      'test',
      '/tmp/test-brain-root',
      expect.objectContaining({ limit: 20 })
    );
  });
});
