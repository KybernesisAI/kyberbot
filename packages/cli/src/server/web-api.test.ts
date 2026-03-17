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

// Mock fs
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockStatSync = vi.fn();
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    statSync: (...args: unknown[]) => mockStatSync(...args),
  };
});

// Mock config
const mockGetRoot = vi.fn().mockReturnValue('/tmp/test-root');
const mockResetConfig = vi.fn();
const mockGetIdentity = vi.fn();
const mockGetAgentName = vi.fn().mockReturnValue('Atlas');
vi.mock('../config.js', () => ({
  paths: {
    soul: '/tmp/test-root/SOUL.md',
    user: '/tmp/test-root/USER.md',
    heartbeat: '/tmp/test-root/HEARTBEAT.md',
  },
  getRoot: () => mockGetRoot(),
  getIdentity: () => mockGetIdentity(),
  getAgentName: () => mockGetAgentName(),
  resetConfig: () => mockResetConfig(),
}));

// Mock timeline
vi.mock('../brain/timeline.js', () => ({
  queryTimeline: vi.fn(),
}));

// Mock messages
const mockListSessions = vi.fn();
const mockGetSessionMessages = vi.fn();
const mockCreateSession = vi.fn();
const mockSaveMessage = vi.fn();
vi.mock('../brain/messages.js', () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  getSessionMessages: (...args: unknown[]) => mockGetSessionMessages(...args),
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  saveMessage: (...args: unknown[]) => mockSaveMessage(...args),
}));

// Mock js-yaml
vi.mock('js-yaml', () => ({
  load: (str: string) => JSON.parse(str),
  dump: (obj: unknown) => JSON.stringify(obj),
}));

const { createWebApiRouter } = await import('./web-api.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/', createWebApiRouter());
  // Debug error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

let app: express.Express;

beforeEach(() => {
  vi.resetAllMocks();
  mockGetRoot.mockReturnValue('/tmp/test-root');
  mockGetAgentName.mockReturnValue('Atlas');
  app = createTestApp();
});

describe('GET /memory/:block', () => {
  it('should return content for valid block', async () => {
    mockReadFileSync.mockReturnValue('# SOUL.md\nTest content');
    mockStatSync.mockReturnValue({ mtime: new Date('2025-01-01') });

    const res = await request(app).get('/memory/soul');
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('# SOUL.md\nTest content');
    expect(res.body.lastModified).toBeDefined();
  });

  it('should return 400 for invalid block', async () => {
    const res = await request(app).get('/memory/invalid');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid block');
  });

  it('should return 404 when file not found', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    mockReadFileSync.mockImplementation(() => { throw err; });

    const res = await request(app).get('/memory/soul');
    expect(res.status).toBe(404);
  });

  it('should return 500 on other read errors', async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('Permission denied'); });

    const res = await request(app).get('/memory/soul');
    expect(res.status).toBe(500);
  });

  it('should accept all valid block names', async () => {
    mockReadFileSync.mockReturnValue('content');
    mockStatSync.mockReturnValue({ mtime: new Date() });

    for (const block of ['soul', 'user', 'heartbeat']) {
      const res = await request(app).get(`/memory/${block}`);
      expect(res.status).toBe(200);
    }
  });
});

describe('PUT /memory/:block', () => {
  it('should write content for valid block', async () => {
    const res = await request(app)
      .put('/memory/soul')
      .send({ content: '# Updated SOUL.md' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/test-root/SOUL.md',
      '# Updated SOUL.md',
      'utf-8'
    );
  });

  it('should return 400 for invalid block', async () => {
    const res = await request(app)
      .put('/memory/admin')
      .send({ content: 'hack' });
    expect(res.status).toBe(400);
  });

  it('should return 400 when content is missing', async () => {
    const res = await request(app)
      .put('/memory/soul')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('content');
  });

  it('should return 400 when content is not a string', async () => {
    const res = await request(app)
      .put('/memory/soul')
      .send({ content: 123 });
    expect(res.status).toBe(400);
  });

  it('should return 500 on write error', async () => {
    mockWriteFileSync.mockImplementation(() => { throw new Error('Disk full'); });

    const res = await request(app)
      .put('/memory/soul')
      .send({ content: 'test' });
    expect(res.status).toBe(500);
  });
});

describe('GET /identity', () => {
  it('should return identity config', async () => {
    mockGetIdentity.mockReturnValue({ agent_name: 'Atlas', timezone: 'UTC' });

    const res = await request(app).get('/identity');
    expect(res.status).toBe(200);
    expect(res.body.agent_name).toBe('Atlas');
  });

  it('should call resetConfig before reading', async () => {
    mockGetIdentity.mockReturnValue({});

    await request(app).get('/identity');
    expect(mockResetConfig).toHaveBeenCalled();
  });

  it('should return 500 on error', async () => {
    mockGetIdentity.mockImplementation(() => { throw new Error('Parse error'); });

    const res = await request(app).get('/identity');
    expect(res.status).toBe(500);
  });
});

describe('PUT /identity', () => {
  it('should update identity fields', async () => {
    mockReadFileSync.mockReturnValue('{"agent_name": "Atlas"}');

    const res = await request(app)
      .put('/identity')
      .send({ agent_name: 'NewName' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalled();
    expect(mockResetConfig).toHaveBeenCalled();
  });

  it('should return 400 for non-object body', async () => {
    mockReadFileSync.mockReturnValue('{}');
    // Send an array — valid JSON that express.json() accepts,
    // but typeof array === 'object' so route validation must also check Array
    const res = await request(app)
      .put('/identity')
      .send([1, 2, 3]);
    expect(res.status).toBe(400);
  });

  it('should validate heartbeat_interval format', async () => {
    const res = await request(app)
      .put('/identity')
      .send({ heartbeat_interval: 'invalid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('heartbeat_interval');
  });

  it('should accept valid heartbeat_interval formats', async () => {
    mockReadFileSync.mockReturnValue('{}');

    for (const interval of ['30m', '2h', '5m', '1h']) {
      const res = await request(app)
        .put('/identity')
        .send({ heartbeat_interval: interval });
      expect(res.status).toBe(200);
    }
  });

  it('should return 500 on write error', async () => {
    mockReadFileSync.mockReturnValue('{}');
    mockWriteFileSync.mockImplementation(() => { throw new Error('Write failed'); });

    const res = await request(app)
      .put('/identity')
      .send({ timezone: 'UTC' });
    expect(res.status).toBe(500);
  });
});

describe('GET /sessions', () => {
  it('should return session list', async () => {
    mockListSessions.mockReturnValue([
      { id: 'web-123', channel: 'web', created_at: '2025-01-01' },
    ]);

    const res = await request(app).get('/sessions');
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
  });

  it('should return empty array on error', async () => {
    mockListSessions.mockImplementation(() => { throw new Error('DB error'); });

    const res = await request(app).get('/sessions');
    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });
});

describe('POST /sessions', () => {
  it('should create a new session', async () => {
    const res = await request(app).post('/sessions');
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toMatch(/^web-\d+-[a-z0-9]+$/);
    expect(mockCreateSession).toHaveBeenCalled();
  });

  it('should return 500 on creation error', async () => {
    mockCreateSession.mockImplementation(() => { throw new Error('DB error'); });

    const res = await request(app).post('/sessions');
    expect(res.status).toBe(500);
  });
});

describe('GET /sessions/:id/messages', () => {
  it('should return formatted messages', async () => {
    mockGetSessionMessages.mockReturnValue([
      {
        id: 1,
        role: 'user',
        content: 'Hello',
        tool_calls_json: null,
        memory_updates_json: null,
        usage_json: '{"tokens": 10}',
        cost_usd: 0.001,
        created_at: '2025-01-01T00:00:00Z',
      },
    ]);

    const res = await request(app).get('/sessions/web-123/messages');
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].role).toBe('user');
    expect(res.body.messages[0].usage).toEqual({ tokens: 10 });
    expect(res.body.messages[0].timestamp).toBeTypeOf('number');
  });

  it('should return empty array on error', async () => {
    mockGetSessionMessages.mockImplementation(() => { throw new Error('Not found'); });

    const res = await request(app).get('/sessions/unknown/messages');
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });
});

describe('POST /sessions/:id/messages', () => {
  it('should save a message', async () => {
    mockSaveMessage.mockReturnValue(42);

    const res = await request(app)
      .post('/sessions/web-123/messages')
      .send({ role: 'user', content: 'Hello' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(42);
  });

  it('should return 400 when role is missing', async () => {
    const res = await request(app)
      .post('/sessions/web-123/messages')
      .send({ content: 'Hello' });
    expect(res.status).toBe(400);
  });

  it('should return 400 when content is missing', async () => {
    const res = await request(app)
      .post('/sessions/web-123/messages')
      .send({ role: 'user' });
    expect(res.status).toBe(400);
  });

  it('should return 500 on save error', async () => {
    mockSaveMessage.mockImplementation(() => { throw new Error('DB error'); });

    const res = await request(app)
      .post('/sessions/web-123/messages')
      .send({ role: 'user', content: 'Hello' });
    expect(res.status).toBe(500);
  });
});

describe('GET /status', () => {
  it('should return agent status', async () => {
    const res = await request(app).get('/status');
    expect(res.status).toBe(200);
    expect(res.body.agent).toBe('Atlas');
    expect(res.body.uptime).toBeTypeOf('number');
    expect(res.body.timestamp).toBeDefined();
  });

  it('should return 500 on error', async () => {
    mockGetAgentName.mockImplementation(() => { throw new Error('Config error'); });

    const res = await request(app).get('/status');
    expect(res.status).toBe(500);
  });
});
