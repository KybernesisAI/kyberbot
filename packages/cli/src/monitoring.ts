/**
 * KyberBot — Monitoring & Error Tracking
 *
 * Provides:
 * - Sentry integration (opt-in via SENTRY_DSN env var)
 * - Process-level error handlers (uncaughtException, unhandledRejection)
 * - Error metrics for health endpoint
 * - Express error middleware
 */

import { createLogger } from './logger.js';
import type { Request, Response, NextFunction } from 'express';

const logger = createLogger('monitor');

// ─── Metrics ────────────────────────────────────────────────────────

const startedAt = Date.now();

interface ErrorRecord {
  message: string;
  timestamp: number;
}

const recentErrors: ErrorRecord[] = [];
const MAX_RECENT_ERRORS = 50;
let totalErrorCount = 0;

function recordError(message: string): void {
  totalErrorCount++;
  recentErrors.push({ message, timestamp: Date.now() });
  if (recentErrors.length > MAX_RECENT_ERRORS) {
    recentErrors.shift();
  }
}

export function getMetrics() {
  const now = Date.now();
  const uptimeMs = now - startedAt;

  // Errors in last 5 minutes
  const fiveMinAgo = now - 5 * 60 * 1000;
  const recentCount = recentErrors.filter(e => e.timestamp > fiveMinAgo).length;

  const mem = process.memoryUsage();

  return {
    uptime_seconds: Math.floor(uptimeMs / 1000),
    uptime_human: formatUptime(uptimeMs),
    errors: {
      total: totalErrorCount,
      last_5m: recentCount,
      recent: recentErrors.slice(-5).map(e => ({
        message: e.message,
        ago: `${Math.floor((now - e.timestamp) / 1000)}s ago`,
      })),
    },
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    },
    node_version: process.version,
    pid: process.pid,
  };
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

// ─── Sentry ─────────────────────────────────────────────────────────

let sentryInitialized = false;

async function initSentry(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.debug('SENTRY_DSN not set — Sentry disabled');
    return;
  }

  try {
    const Sentry = await import('@sentry/node');

    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.KYBERBOT_VERSION || undefined,
      tracesSampleRate: 0.1,
      beforeSend(event) {
        // Strip any local file paths from stack traces for privacy
        if (event.exception?.values) {
          for (const ex of event.exception.values) {
            if (ex.stacktrace?.frames) {
              for (const frame of ex.stacktrace.frames) {
                if (frame.filename) {
                  frame.filename = frame.filename.replace(/\/Users\/[^/]+\//, '~/');
                }
              }
            }
          }
        }
        return event;
      },
    });

    sentryInitialized = true;
    logger.info('Sentry error tracking enabled');
  } catch (error) {
    // Sentry is optional — don't fail if import fails
    logger.debug('Sentry not available (install @sentry/node to enable)', { error: String(error) });
  }
}

function captureException(error: unknown): void {
  if (!sentryInitialized) return;

  import('@sentry/node').then(Sentry => {
    Sentry.captureException(error);
  }).catch(() => {
    // Silently ignore if Sentry becomes unavailable
  });
}

// ─── Process Error Handlers ─────────────────────────────────────────

function installProcessHandlers(): void {
  process.on('uncaughtException', (error: Error) => {
    logger.error('Uncaught exception — process will exit', {
      error: error.message,
      stack: error.stack,
    });
    recordError(`uncaughtException: ${error.message}`);
    captureException(error);

    // Node.js docs: after an uncaught exception the process is in an undefined
    // state. Continuing risks silent data corruption. Exit with a non-zero code
    // so a process manager (systemd, pm2, etc.) can restart us cleanly.
    setTimeout(() => process.exit(1), 1000);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;

    logger.error('Unhandled promise rejection', {
      error: message,
      stack,
    });
    recordError(`unhandledRejection: ${message}`);
    captureException(reason);
  });

  logger.debug('Process error handlers installed');
}

// ─── Express Error Middleware ────────────────────────────────────────

/**
 * Express error-handling middleware.
 * Must be registered AFTER all routes (4-arg signature is required).
 */
export function errorMiddleware(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const message = err.message || 'Internal server error';

  logger.error('Express error', {
    error: message,
    stack: err.stack,
    method: req.method,
    path: req.path,
  });

  recordError(`${req.method} ${req.path}: ${message}`);
  captureException(err);

  if (!res.headersSent) {
    res.status(500).json({
      error: 'Internal server error',
      // Don't leak error details in production
      ...(process.env.NODE_ENV !== 'production' && { message }),
    });
  }
}

// ─── Init ───────────────────────────────────────────────────────────

/**
 * Initialize all monitoring. Call once at startup, before services start.
 */
export async function initMonitoring(): Promise<void> {
  installProcessHandlers();
  await initSentry();
  logger.info('Monitoring initialized', {
    sentry: sentryInitialized ? 'enabled' : 'disabled',
    pid: process.pid,
  });
}
