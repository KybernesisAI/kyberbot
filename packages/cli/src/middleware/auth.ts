/**
 * KyberBot — API Authentication Middleware
 *
 * Token-based authentication for the brain API and channel endpoints.
 */

import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../logger.js';

const logger = createLogger('auth');

let apiToken: string | null = null;

export function getApiToken(): string {
  if (apiToken) return apiToken;

  const envToken = process.env.KYBERBOT_API_TOKEN;
  if (envToken) {
    apiToken = envToken;
    logger.info('Using API token from environment');
    return apiToken;
  }

  apiToken = randomUUID();
  logger.info('Generated new API token');
  logger.info(`API Token: ${apiToken}`);
  logger.info('Set KYBERBOT_API_TOKEN environment variable to persist this token');

  return apiToken;
}

export function validateToken(token: string): boolean {
  const expected = getApiToken();
  return token === expected;
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
    logger.warn('Missing Authorization header', { path: req.path, ip: req.ip });
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
    logger.warn('Invalid API token', { path: req.path, ip: req.ip });
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API token',
    });
    return;
  }

  next();
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
