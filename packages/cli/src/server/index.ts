/**
 * KyberBot — Express Server
 *
 * Minimal server providing:
 * - Health endpoint
 * - Brain REST API
 * - Channel bridges (Telegram, WhatsApp)
 */

import express from 'express';
import { createLogger } from '../logger.js';
import { getServerPort, getIdentity, getRoot } from '../config.js';
import { authMiddleware, getApiToken } from '../middleware/auth.js';
import { createBrainRouter } from './brain-api.js';
import { executeHandler } from './execute-api.js';
import { createWebApiRouter } from './web-api.js';
import { createManagementRouter } from './management-api.js';
import { chatSseHandler } from './chat-sse.js';
import { ServiceHandle } from '../types.js';
import { TelegramChannel } from './channels/telegram.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { Channel } from './channels/types.js';
import { getMetrics, errorMiddleware } from '../monitoring.js';
import { getServiceStatuses } from '../orchestrator.js';
import http from 'http';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const logger = createLogger('server');

const channels: Channel[] = [];

export async function startServer(options: {
  enableChannels?: boolean;
} = {}): Promise<ServiceHandle> {
  const app = express();
  const port = getServerPort();

  app.use(express.json());

  // Public health endpoint — comprehensive system status
  app.get('/health', (_req, res) => {
    const metrics = getMetrics();
    const services = getServiceStatuses();
    const allHealthy = services.every(s => s.status === 'running' || s.status === 'disabled');

    res.json({
      status: allHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: metrics.uptime_human,
      channels: channels.map(c => ({ name: c.name, connected: c.isConnected() })),
      services: services.map(s => ({ name: s.name, status: s.status })),
      errors: metrics.errors,
      memory: metrics.memory,
      pid: metrics.pid,
      node_version: metrics.node_version,
    });
  });

  // Brain API (authenticated)
  app.use('/brain', authMiddleware, createBrainRouter());

  // Execute API (authenticated)
  app.post('/api/execute', authMiddleware, executeHandler);

  // Chat SSE (authenticated) — must be before the web router
  app.post('/api/web/chat', authMiddleware, chatSseHandler);

  // Web API (authenticated)
  app.use('/api/web', authMiddleware, createWebApiRouter());

  // Management API (authenticated) — skill/agent/channel/heartbeat CRUD
  app.use('/api/web/manage', authMiddleware, createManagementRouter(channels));

  // Serve web UI static files
  try {
    // Try to find @kyberbot/web dist directory
    const webDistPaths = [
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'dist'),
      join(process.cwd(), 'node_modules', '@kyberbot', 'web', 'dist'),
    ];

    for (const distPath of webDistPaths) {
      if (existsSync(join(distPath, 'index.html'))) {
        app.use('/ui', express.static(distPath));
        app.get('/ui/*', (_req, res) => {
          res.sendFile(join(distPath, 'index.html'));
        });
        logger.info(`Web UI serving from ${distPath}`);
        break;
      }
    }
  } catch (err) {
    logger.debug('Web UI not available', { error: String(err) });
  }

  // Start channels if configured
  if (options.enableChannels !== false) {
    try {
      const identity = getIdentity();

      if (identity.channels?.telegram?.bot_token) {
        const telegram = new TelegramChannel(identity.channels.telegram);
        await telegram.start();
        channels.push(telegram);
      }

      if (identity.channels?.whatsapp?.enabled) {
        const whatsapp = new WhatsAppChannel();
        await whatsapp.start();
        channels.push(whatsapp);
      }
    } catch (error) {
      logger.warn('Channel initialization failed (non-fatal)', { error: String(error) });
    }
  }

  // Error middleware — must be after all routes
  app.use(errorMiddleware);

  const server = http.createServer(app);

  return new Promise((resolve) => {
    server.listen(port, () => {
      logger.info(`Server listening on port ${port}`);

      if (process.env.KYBERBOT_API_TOKEN) {
        logger.info('API authentication enabled');
      } else {
        logger.warn('API authentication DISABLED — brain endpoints are publicly accessible on this network. Set KYBERBOT_API_TOKEN in .env to secure them.');
      }

      logger.info(`Web UI: http://localhost:${port}/ui`);

      resolve({
        stop: async () => {
          // Stop channels
          for (const channel of channels) {
            try {
              await channel.stop();
            } catch (error) {
              logger.error(`Failed to stop ${channel.name} channel`, { error: String(error) });
            }
          }
          channels.length = 0;

          // Stop server
          await new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
          logger.info('Server stopped');
        },
        status: () => (server.listening ? 'running' : 'stopped'),
      });
    });
  });
}
