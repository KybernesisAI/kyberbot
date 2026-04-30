/**
 * KyberBot — Agent Router
 *
 * Creates an Express router with all routes scoped to a specific agent root.
 * Used by both single-agent mode (server/index.ts) and fleet mode (FleetManager).
 */

import express, { Router } from 'express';
import type { Express } from 'express';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { createBrainRouter } from './brain-api.js';
import { createWebApiRouter } from './web-api.js';
import { createManagementRouter } from './management-api.js';
import { createBusApiRouter } from './bus-api.js';
import { createArpRouter } from './arp/router.js';
import { chatSseHandler } from './chat-sse.js';
import { executeHandler } from './execute-api.js';
import { Channel } from './channels/types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-router');

/**
 * Mount web UI static files on an Express app or router.
 * Call BEFORE auth middleware so browsers can load the page without a token.
 * @param app Express app or router to mount on
 * @param prefix URL prefix ('' for root, '/agent/name' for fleet)
 */
export function mountWebUi(app: { use: (...args: any[]) => any; get: (...args: any[]) => any }, prefix: string): void {
  try {
    const webDistPaths = [
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'dist'),
      join(process.cwd(), 'node_modules', '@kyberbot', 'web', 'dist'),
    ];

    for (const distPath of webDistPaths) {
      if (existsSync(join(distPath, 'index.html'))) {
        app.use(`${prefix}/ui`, express.static(distPath));
        app.get(`${prefix}/ui/*`, (_req: any, res: any) => {
          res.sendFile(join(distPath, 'index.html'));
        });
        logger.debug(`Web UI available at ${prefix || '/'}/ui`);
        break;
      }
    }
  } catch (err) {
    logger.debug('Web UI not available', { error: String(err) });
  }
}

/**
 * Create an Express router with all agent-specific routes.
 * Every route within this router operates in the context of the given root.
 * NOTE: Web UI is NOT included here — mount it separately before auth.
 */
export function createAgentRouter(root: string, channels: Channel[]): Router {
  const router = Router();

  // Brain API
  router.use('/brain', createBrainRouter(root));

  // Execute API
  router.post('/api/execute', executeHandler);

  // Chat SSE — must be before the web router
  router.post('/api/web/chat', (req, res) => chatSseHandler(req, res, root));

  // Web API
  router.use('/api/web', createWebApiRouter(root));

  // Bus API (receives messages from remote agents/fleet)
  router.use('/api/bus', createBusApiRouter(root));

  // Management API
  router.use('/api/web/manage', createManagementRouter(channels, root));

  // ── ARP unification (Phase B) — typed agent-to-agent endpoints ─────
  // Mounted at /api/arp; the cloud-bridge kyberbot adapter dispatches
  // structured action requests here (notes.search, knowledge.query,
  // etc.) instead of running them through /api/web/chat. Each endpoint
  // filters by project_id / classification / tags at the data layer
  // and applies obligations as code. Cedar PDP on the cloud side
  // gates whether the call happens; this router enforces scope at the
  // brain.
  router.use('/api/arp', createArpRouter(root));

  return router;
}
