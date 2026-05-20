import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const {
  createSession,
  saveMessage,
  getSessionMessages,
  listSessions,
  getClaudeSessionId,
  setClaudeSessionId,
  getLatestSessionId,
  resetMessagesDb,
} = await import('./messages.js');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kyberbot-messages-'));
});

afterAll(async () => {
  resetMessagesDb(root);
  await rm(root, { recursive: true, force: true });
});

describe('createSession', () => {
  it('creates a session that shows up in listSessions', () => {
    createSession(root, 'sess-1', 'web');
    const sessions = listSessions(root);
    expect(sessions.some(s => s.id === 'sess-1')).toBe(true);
  });

  it('is idempotent — calling twice with the same id is OK', () => {
    expect(() => createSession(root, 'sess-idem', 'web')).not.toThrow();
    expect(() => createSession(root, 'sess-idem', 'web')).not.toThrow();
    expect(listSessions(root).filter(s => s.id === 'sess-idem')).toHaveLength(1);
  });

  it('records the channel correctly', () => {
    createSession(root, 'sess-channel-cli', 'cli');
    const session = listSessions(root).find(s => s.id === 'sess-channel-cli');
    expect(session?.channel).toBe('cli');
  });
});

describe('saveMessage', () => {
  it('returns a positive message id', () => {
    const id = saveMessage(root, 'sess-save-1', 'user', 'Hello from a unit test');
    expect(id).toBeGreaterThan(0);
  });

  it('auto-creates the session when it does not exist', () => {
    saveMessage(root, 'sess-autocreate', 'user', 'auto-created session');
    const sessions = listSessions(root);
    expect(sessions.some(s => s.id === 'sess-autocreate')).toBe(true);
  });

  it('persists tool_calls / memory_updates / usage / cost as JSON columns', () => {
    saveMessage(root, 'sess-rich', 'assistant', 'reply', {
      toolCalls: [{ name: 'search', args: { q: 'foo' } }],
      memoryUpdates: ['fact:added preference'],
      usage: { inputTokens: 100, outputTokens: 50 },
      costUsd: 0.0015,
    });

    const messages = getSessionMessages(root, 'sess-rich');
    expect(messages).toHaveLength(1);
    const m = messages[0];
    expect(JSON.parse(m.tool_calls_json!)).toEqual([{ name: 'search', args: { q: 'foo' } }]);
    expect(JSON.parse(m.memory_updates_json!)).toEqual(['fact:added preference']);
    expect(JSON.parse(m.usage_json!)).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(m.cost_usd).toBeCloseTo(0.0015);
  });

  it('stores null for optional fields when not provided', () => {
    saveMessage(root, 'sess-bare', 'user', 'bare message');
    const m = getSessionMessages(root, 'sess-bare')[0];
    expect(m.tool_calls_json).toBeNull();
    expect(m.memory_updates_json).toBeNull();
    expect(m.usage_json).toBeNull();
    expect(m.cost_usd).toBeNull();
  });

  it("sets the session title from the FIRST user message and doesn't overwrite later", () => {
    saveMessage(root, 'sess-title', 'user', 'first user message — this becomes the title');
    saveMessage(root, 'sess-title', 'assistant', 'an assistant reply');
    saveMessage(root, 'sess-title', 'user', 'a second user message that should NOT replace the title');

    const session = listSessions(root).find(s => s.id === 'sess-title');
    expect(session?.title).toBe('first user message — this becomes the title');
  });

  it("doesn't set a title from an assistant message", () => {
    saveMessage(root, 'sess-no-user-title', 'assistant', 'assistant first — should not be the title');
    const session = listSessions(root).find(s => s.id === 'sess-no-user-title');
    expect(session?.title).toBeNull();
  });

  it('truncates the title to 100 chars', () => {
    const longMessage = 'X'.repeat(250);
    saveMessage(root, 'sess-long-title', 'user', longMessage);
    const session = listSessions(root).find(s => s.id === 'sess-long-title');
    expect(session?.title?.length).toBe(100);
  });
});

describe('getSessionMessages', () => {
  it('returns messages ordered by created_at ASC', async () => {
    saveMessage(root, 'sess-order', 'user', 'one');
    await new Promise(r => setTimeout(r, 10));
    saveMessage(root, 'sess-order', 'assistant', 'two');
    await new Promise(r => setTimeout(r, 10));
    saveMessage(root, 'sess-order', 'user', 'three');

    const messages = getSessionMessages(root, 'sess-order');
    expect(messages.map(m => m.content)).toEqual(['one', 'two', 'three']);
  });

  it('returns empty array for unknown session', () => {
    expect(getSessionMessages(root, 'sess-does-not-exist')).toEqual([]);
  });
});

describe('listSessions', () => {
  it('orders sessions by updated_at DESC (most recent first)', async () => {
    saveMessage(root, 'sess-old', 'user', 'old session');
    await new Promise(r => setTimeout(r, 20));
    saveMessage(root, 'sess-new', 'user', 'new session');

    const sessions = listSessions(root);
    const newIdx = sessions.findIndex(s => s.id === 'sess-new');
    const oldIdx = sessions.findIndex(s => s.id === 'sess-old');
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 25; i++) {
      createSession(root, `sess-limit-${i}`, 'web');
    }
    const limited = listSessions(root, 5);
    expect(limited.length).toBeLessThanOrEqual(5);
  });

  it('includes message_count from the LEFT JOIN', () => {
    createSession(root, 'sess-count-zero', 'web');
    saveMessage(root, 'sess-count-three', 'user', 'msg 1');
    saveMessage(root, 'sess-count-three', 'assistant', 'msg 2');
    saveMessage(root, 'sess-count-three', 'user', 'msg 3');

    const sessions = listSessions(root, 100);
    const zero = sessions.find(s => s.id === 'sess-count-zero');
    const three = sessions.find(s => s.id === 'sess-count-three');
    expect(zero?.message_count).toBe(0);
    expect(three?.message_count).toBe(3);
  });
});

describe('claude session id', () => {
  it('returns null when not set', () => {
    createSession(root, 'sess-claude-empty', 'web');
    expect(getClaudeSessionId(root, 'sess-claude-empty')).toBeNull();
  });

  it('returns null for unknown session', () => {
    expect(getClaudeSessionId(root, 'sess-claude-unknown')).toBeNull();
  });

  it('round-trips via set + get', () => {
    createSession(root, 'sess-claude-rt', 'web');
    setClaudeSessionId(root, 'sess-claude-rt', 'claude-abc-123');
    expect(getClaudeSessionId(root, 'sess-claude-rt')).toBe('claude-abc-123');
  });
});

describe('getLatestSessionId', () => {
  it('returns null when no session for the channel', async () => {
    const freshRoot = await mkdtemp(join(tmpdir(), 'kyberbot-messages-latest-'));
    try {
      expect(getLatestSessionId(freshRoot, 'web')).toBeNull();
    } finally {
      resetMessagesDb(freshRoot);
      await rm(freshRoot, { recursive: true, force: true });
    }
  });

  it('returns the most-recently-updated session id for the channel', async () => {
    createSession(root, 'sess-latest-old', 'web');
    await new Promise(r => setTimeout(r, 20));
    saveMessage(root, 'sess-latest-new', 'user', 'most recent');
    const latest = getLatestSessionId(root, 'web');
    expect(latest).toBe('sess-latest-new');
  });

  it('filters by channel', () => {
    createSession(root, 'sess-channel-web', 'web');
    createSession(root, 'sess-channel-cli-only', 'cli-only');
    expect(getLatestSessionId(root, 'cli-only')).toBe('sess-channel-cli-only');
    expect(getLatestSessionId(root, 'cli-only')).not.toBe('sess-channel-web');
  });
});

describe('schema — ARP metadata columns present after migration', () => {
  it('has project_id / tags_json / classification / connection_id / source_did columns on sessions', async () => {
    // Trigger ensureDatabase via a simple call
    createSession(root, 'sess-schema-check', 'web');
    const { resetMessagesDb: _r } = await import('./messages.js');
    void _r;

    // Read columns directly
    const { default: Database } = await import('libsql');
    const db = new Database(join(root, 'data', 'messages.db'), { readonly: true });
    try {
      const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
      const names = new Set(cols.map(c => c.name));
      for (const col of ['project_id', 'tags_json', 'classification', 'connection_id', 'source_did']) {
        expect(names.has(col)).toBe(true);
      }
    } finally {
      db.close();
    }
  });
});
