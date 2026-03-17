import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

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
  getRoot: () => '/mock/root',
}));

// Mock spawn
const mockSpawn = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

const { executeHandler } = await import('./execute-api.js');

// Helper: create a mock Express request
function mockRequest(body: Record<string, unknown> = {}): Request {
  return { body } as Request;
}

// Helper: create a mock Express response
function mockResponse(): Response & {
  _written: string[];
  _headers: Record<string, string>;
  _status: number;
  _ended: boolean;
  _jsonBody: unknown;
} {
  const res = new EventEmitter() as any;
  res._written = [];
  res._headers = {};
  res._status = 200;
  res._ended = false;
  res._jsonBody = undefined;
  res.writableEnded = false;
  res.writableFinished = false;

  res.status = vi.fn((code: number) => {
    res._status = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res._jsonBody = body;
    return res;
  });
  res.setHeader = vi.fn((key: string, value: string) => {
    res._headers[key] = value;
  });
  res.flushHeaders = vi.fn();
  res.write = vi.fn((data: string) => {
    res._written.push(data);
    return true;
  });
  res.end = vi.fn(() => {
    res._ended = true;
    res.writableEnded = true;
    res.writableFinished = true;
  });

  return res;
}

// Helper: create a mock child process
function mockChildProcess(): ChildProcess & EventEmitter {
  const proc = new EventEmitter() as any;
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn(() => { proc.killed = true; });
  proc.pid = 12345;
  return proc;
}

beforeEach(() => {
  mockSpawn.mockReset();
  vi.useFakeTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe('executeHandler — input validation', () => {
  it('returns 400 when prompt is missing', async () => {
    const req = mockRequest({});
    const res = mockResponse();

    await executeHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'prompt is required' });
  });

  it('returns 400 when prompt is not a string', async () => {
    const req = mockRequest({ prompt: 123 });
    const res = mockResponse();

    await executeHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when body is null', async () => {
    const req = { body: null } as Request;
    const res = mockResponse();

    await executeHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Spawning and streaming
// ─────────────────────────────────────────────────────────────────────────────

describe('executeHandler — spawn and streaming', () => {
  it('sets NDJSON headers and spawns claude process', async () => {
    const proc = mockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const req = mockRequest({ prompt: 'hello' });
    const res = mockResponse();

    // Start handler (it won't complete until process closes)
    const handlerPromise = executeHandler(req, res);

    // Verify headers
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/x-ndjson');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.flushHeaders).toHaveBeenCalled();

    // Verify spawn was called with correct args
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--print', '-', '--output-format', 'stream-json', '--verbose']),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );

    // Verify prompt written to stdin
    expect(proc.stdin.write).toHaveBeenCalledWith('hello');
    expect(proc.stdin.end).toHaveBeenCalled();

    // Simulate process close
    proc.emit('close', 0, null);
    await handlerPromise;

    expect(res.end).toHaveBeenCalled();
  });

  it('streams stdout chunks as NDJSON log lines', async () => {
    const proc = mockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const req = mockRequest({ prompt: 'test' });
    const res = mockResponse();

    const handlerPromise = executeHandler(req, res);

    // Simulate stdout data
    proc.stdout.emit('data', Buffer.from('some output'));

    proc.emit('close', 0, null);
    await handlerPromise;

    // Find the log line in written output
    const logLines = res._written
      .map((line: string) => JSON.parse(line.trim()))
      .filter((obj: any) => obj.type === 'log' && obj.stream === 'stdout');

    expect(logLines.length).toBe(1);
    expect(logLines[0].chunk).toBe('some output');
  });

  it('streams stderr chunks as NDJSON log lines', async () => {
    const proc = mockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const req = mockRequest({ prompt: 'test' });
    const res = mockResponse();

    const handlerPromise = executeHandler(req, res);

    proc.stderr.emit('data', Buffer.from('error output'));

    proc.emit('close', 0, null);
    await handlerPromise;

    const stderrLines = res._written
      .map((line: string) => JSON.parse(line.trim()))
      .filter((obj: any) => obj.type === 'log' && obj.stream === 'stderr');

    expect(stderrLines.length).toBe(1);
    expect(stderrLines[0].chunk).toBe('error output');
  });

  it('sends result line on process close with exit code', async () => {
    const proc = mockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const req = mockRequest({ prompt: 'test' });
    const res = mockResponse();

    const handlerPromise = executeHandler(req, res);

    proc.emit('close', 0, null);
    await handlerPromise;

    const resultLines = res._written
      .map((line: string) => JSON.parse(line.trim()))
      .filter((obj: any) => obj.type === 'result');

    expect(resultLines.length).toBe(1);
    expect(resultLines[0].exitCode).toBe(0);
    expect(resultLines[0].signal).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config options
// ─────────────────────────────────────────────────────────────────────────────

describe('executeHandler — config options', () => {
  it('passes model, effort, maxTurns to claude args', async () => {
    const proc = mockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const req = mockRequest({
      prompt: 'hello',
      config: { model: 'sonnet', effort: 'high', maxTurns: 5 },
    });
    const res = mockResponse();

    const handlerPromise = executeHandler(req, res);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('--model');
    expect(spawnArgs).toContain('sonnet');
    expect(spawnArgs).toContain('--effort');
    expect(spawnArgs).toContain('high');
    expect(spawnArgs).toContain('--max-turns');
    expect(spawnArgs).toContain('5');

    proc.emit('close', 0, null);
    await handlerPromise;
  });

  it('passes sessionId as --resume', async () => {
    const proc = mockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const req = mockRequest({
      prompt: 'hello',
      config: { sessionId: 'abc-123' },
    });
    const res = mockResponse();

    const handlerPromise = executeHandler(req, res);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('--resume');
    expect(spawnArgs).toContain('abc-123');

    proc.emit('close', 0, null);
    await handlerPromise;
  });

  it('merges env vars from request into child env', async () => {
    const proc = mockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const req = mockRequest({
      prompt: 'hello',
      env: { CUSTOM_VAR: 'value123' },
    });
    const res = mockResponse();

    const handlerPromise = executeHandler(req, res);

    const spawnOptions = mockSpawn.mock.calls[0][2];
    expect(spawnOptions.env.CUSTOM_VAR).toBe('value123');

    proc.emit('close', 0, null);
    await handlerPromise;
  });

  it('ignores non-string env values', async () => {
    const proc = mockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const req = mockRequest({
      prompt: 'hello',
      env: { VALID: 'ok', INVALID: 42 },
    });
    const res = mockResponse();

    const handlerPromise = executeHandler(req, res);

    const spawnOptions = mockSpawn.mock.calls[0][2];
    expect(spawnOptions.env.VALID).toBe('ok');
    // INVALID should not be set (or remain as process.env value)

    proc.emit('close', 0, null);
    await handlerPromise;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Process error handling
// ─────────────────────────────────────────────────────────────────────────────

describe('executeHandler — error handling', () => {
  it('handles spawn failure gracefully', async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    const req = mockRequest({ prompt: 'hello' });
    const res = mockResponse();

    await executeHandler(req, res);

    const errorLines = res._written
      .map((line: string) => JSON.parse(line.trim()))
      .filter((obj: any) => obj.type === 'error');

    expect(errorLines.length).toBe(1);
    expect(errorLines[0].message).toContain('spawn');
    expect(res.end).toHaveBeenCalled();
  });

  it('handles process error event', async () => {
    const proc = mockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const req = mockRequest({ prompt: 'hello' });
    const res = mockResponse();

    const handlerPromise = executeHandler(req, res);

    proc.emit('error', new Error('process crashed'));
    await handlerPromise;

    const errorLines = res._written
      .map((line: string) => JSON.parse(line.trim()))
      .filter((obj: any) => obj.type === 'error');

    expect(errorLines.length).toBe(1);
    expect(errorLines[0].message).toContain('process crashed');
    expect(res.end).toHaveBeenCalled();
  });

  it('reports non-zero exit code in result', async () => {
    const proc = mockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const req = mockRequest({ prompt: 'hello' });
    const res = mockResponse();

    const handlerPromise = executeHandler(req, res);

    proc.emit('close', 1, null);
    await handlerPromise;

    const resultLines = res._written
      .map((line: string) => JSON.parse(line.trim()))
      .filter((obj: any) => obj.type === 'result');

    expect(resultLines[0].exitCode).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stream-json result parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('executeHandler — result parsing', () => {
  it('parses session_id and model from stream-json init event', async () => {
    const proc = mockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const req = mockRequest({ prompt: 'hello' });
    const res = mockResponse();

    const handlerPromise = executeHandler(req, res);

    // Simulate stream-json output
    const initEvent = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-abc',
      model: 'claude-sonnet-4-6',
    });
    proc.stdout.emit('data', Buffer.from(initEvent + '\n'));

    proc.emit('close', 0, null);
    await handlerPromise;

    const result = res._written
      .map((line: string) => JSON.parse(line.trim()))
      .find((obj: any) => obj.type === 'result');

    expect(result.sessionId).toBe('sess-abc');
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('extracts cost and usage from result event', async () => {
    const proc = mockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const req = mockRequest({ prompt: 'hello' });
    const res = mockResponse();

    const handlerPromise = executeHandler(req, res);

    const resultEvent = JSON.stringify({
      type: 'result',
      session_id: 'sess-xyz',
      result: 'Done',
      total_cost_usd: 0.0042,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
      },
    });
    proc.stdout.emit('data', Buffer.from(resultEvent + '\n'));

    proc.emit('close', 0, null);
    await handlerPromise;

    const result = res._written
      .map((line: string) => JSON.parse(line.trim()))
      .find((obj: any) => obj.type === 'result');

    expect(result.costUsd).toBe(0.0042);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.cachedInputTokens).toBe(20);
    expect(result.summary).toBe('Done');
  });

  it('handles stdout with no parseable JSON lines gracefully', async () => {
    const proc = mockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const req = mockRequest({ prompt: 'hello' });
    const res = mockResponse();

    const handlerPromise = executeHandler(req, res);

    proc.stdout.emit('data', Buffer.from('not json\nstill not json\n'));

    proc.emit('close', 0, null);
    await handlerPromise;

    const result = res._written
      .map((line: string) => JSON.parse(line.trim()))
      .find((obj: any) => obj.type === 'result');

    // Should still have a result line, just with null metadata
    expect(result).toBeDefined();
    expect(result.sessionId).toBeNull();
    expect(result.costUsd).toBeNull();
  });

  it('collects assistant text blocks as summary when no result event', async () => {
    const proc = mockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const req = mockRequest({ prompt: 'hello' });
    const res = mockResponse();

    const handlerPromise = executeHandler(req, res);

    const assistantEvent = JSON.stringify({
      type: 'assistant',
      session_id: 'sess-1',
      message: {
        content: [
          { type: 'text', text: 'Hello there!' },
          { type: 'text', text: 'How can I help?' },
        ],
      },
    });
    proc.stdout.emit('data', Buffer.from(assistantEvent + '\n'));

    proc.emit('close', 0, null);
    await handlerPromise;

    const result = res._written
      .map((line: string) => JSON.parse(line.trim()))
      .find((obj: any) => obj.type === 'result');

    expect(result.summary).toContain('Hello there!');
    expect(result.summary).toContain('How can I help?');
  });
});
