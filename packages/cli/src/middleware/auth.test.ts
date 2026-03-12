import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// We need to mock the logger before importing the module under test
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Dynamic import so mocks are in place
const { authMiddleware, validateToken, getApiToken, optionalAuthMiddleware } =
  await import('./auth.js');

function mockReq(headers: Record<string, string> = {}, path = '/test'): Request {
  return { headers, path, ip: '127.0.0.1' } as unknown as Request;
}

function mockRes(): Response & { _status: number; _body: unknown } {
  const res: any = { _status: 200, _body: null };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (body: unknown) => { res._body = body; return res; };
  return res;
}

describe('auth middleware', () => {
  const originalEnv = process.env.KYBERBOT_API_TOKEN;

  afterEach(() => {
    // Restore env
    if (originalEnv !== undefined) {
      process.env.KYBERBOT_API_TOKEN = originalEnv;
    } else {
      delete process.env.KYBERBOT_API_TOKEN;
    }
  });

  describe('when KYBERBOT_API_TOKEN is not set', () => {
    beforeEach(() => {
      delete process.env.KYBERBOT_API_TOKEN;
    });

    it('should pass through without auth', () => {
      const req = mockReq();
      const res = mockRes();
      let called = false;
      const next: NextFunction = () => { called = true; };

      authMiddleware(req, res, next);
      expect(called).toBe(true);
    });
  });

  describe('when KYBERBOT_API_TOKEN is set', () => {
    const TEST_TOKEN = 'test-secret-token-12345';

    beforeEach(() => {
      process.env.KYBERBOT_API_TOKEN = TEST_TOKEN;
    });

    it('should reject requests without Authorization header', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = vi.fn();

      authMiddleware(req, res, next);

      expect(res._status).toBe(401);
      expect(res._body).toMatchObject({ error: 'Unauthorized' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject requests with wrong scheme', () => {
      const req = mockReq({ authorization: `Basic ${TEST_TOKEN}` });
      const res = mockRes();
      const next: NextFunction = vi.fn();

      authMiddleware(req, res, next);

      expect(res._status).toBe(401);
      expect(res._body).toMatchObject({
        error: 'Unauthorized',
        message: expect.stringContaining('Invalid Authorization format'),
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject requests with invalid token', () => {
      const req = mockReq({ authorization: 'Bearer wrong-token' });
      const res = mockRes();
      const next: NextFunction = vi.fn();

      authMiddleware(req, res, next);

      expect(res._status).toBe(401);
      expect(res._body).toMatchObject({
        error: 'Unauthorized',
        message: 'Invalid API token',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should allow requests with valid Bearer token', () => {
      const req = mockReq({ authorization: `Bearer ${TEST_TOKEN}` });
      const res = mockRes();
      let called = false;
      const next: NextFunction = () => { called = true; };

      authMiddleware(req, res, next);

      expect(called).toBe(true);
      expect(res._status).toBe(200); // unchanged
    });
  });
});

describe('validateToken', () => {
  it('should return true for matching token', () => {
    const token = getApiToken();
    expect(validateToken(token)).toBe(true);
  });

  it('should return false for non-matching token', () => {
    expect(validateToken('definitely-wrong')).toBe(false);
  });
});

describe('optionalAuthMiddleware', () => {
  it('should always call next', () => {
    const req = mockReq();
    const res = mockRes();
    const next: NextFunction = vi.fn();

    optionalAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('should set authenticated=true with valid token', () => {
    const token = getApiToken();
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next: NextFunction = vi.fn();

    optionalAuthMiddleware(req, res, next);

    expect((req as any).authenticated).toBe(true);
    expect(next).toHaveBeenCalled();
  });

  it('should not set authenticated with invalid token', () => {
    const req = mockReq({ authorization: 'Bearer wrong' });
    const res = mockRes();
    const next: NextFunction = vi.fn();

    optionalAuthMiddleware(req, res, next);

    expect((req as any).authenticated).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });
});
