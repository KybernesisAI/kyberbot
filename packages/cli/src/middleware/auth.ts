/**
 * KyberBot — API Authentication Middleware
 *
 * Token-based authentication for the brain API and channel endpoints.
 */

import { randomUUID, timingSafeEqual } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../logger.js';

const logger = createLogger('auth');

let apiToken: string | null = null;

// Per-root token cache (for multi-agent runtime — Phase 3)
const agentTokens = new Map<string, string>();

export function getApiToken(): string {
  if (apiToken) return apiToken;

  const envToken = process.env.KYBERBOT_API_TOKEN;
  if (envToken) {
    apiToken = envToken;
    logger.info('Using API token from environment');
    return apiToken;
  }

  apiToken = randomUUID();
  logger.info('Generated new API token (set KYBERBOT_API_TOKEN to persist)');

  return apiToken;
}

export function validateToken(token: string): boolean {
  const expected = getApiToken();
  return safeCompare(token, expected);
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against bufB to avoid short-circuit timing leak on length mismatch
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const envToken = process.env.KYBERBOT_API_TOKEN;
  if (!envToken) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    // Only log at debug for localhost (web UI polling without token)
    const isLocal = req.ip === '::1' || req.ip === '127.0.0.1' || req.ip === '::ffff:127.0.0.1';
    if (isLocal) {
      logger.debug('Missing auth from localhost', { path: req.path });
    } else {
      logger.warn('Missing Authorization header', { path: req.path, ip: req.ip });
    }
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing Authorization header',
    });
    return;
  }

  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    logger.warn('Invalid Authorization format', { path: req.path, scheme });
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid Authorization format. Use: Bearer <token>',
    });
    return;
  }

  if (!validateToken(token)) {
    // Only log at debug for localhost (desktop/web UI with stale token)
    const isLocal = req.ip === '::1' || req.ip === '127.0.0.1' || req.ip === '::ffff:127.0.0.1';
    if (isLocal) {
      logger.debug('Invalid token from localhost', { path: req.path });
    } else {
      logger.warn('Invalid API token', { path: req.path, ip: req.ip });
    }
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API token',
    });
    return;
  }

  next();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PER-ROOT TOKEN SUPPORT (for multi-agent runtime)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Load the API token for a specific agent root by reading its .env file.
 */
export function loadTokenForRoot(root: string): string | null {
  const cached = agentTokens.get(root);
  if (cached) return cached;

  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return null;

  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('KYBERBOT_API_TOKEN=')) {
        let value = trimmed.slice('KYBERBOT_API_TOKEN='.length).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (value) {
          agentTokens.set(root, value);
          return value;
        }
      }
    }
  } catch {
    // .env read failed
  }
  return null;
}

/**
 * Validate a token against a specific agent root.
 */
export function validateTokenForRoot(token: string, root: string): boolean {
  const expected = loadTokenForRoot(root);
  return expected ? safeCompare(token, expected) : false;
}

/**
 * Clear cached token for a root (e.g., after token rotation).
 */
export function clearTokenCache(root?: string): void {
  if (root) agentTokens.delete(root);
  else agentTokens.clear();
}

export function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    const [scheme, token] = authHeader.split(' ');
    if (scheme === 'Bearer' && token && validateToken(token)) {
      (req as any).authenticated = true;
    }
  }

  next();
}
