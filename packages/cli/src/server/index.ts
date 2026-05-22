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
import { resolveBindHost } from './bind-host.js';
import { createAgentRouter, mountWebUi } from './agent-router.js';
import { ServiceHandle } from '../types.js';
import { TelegramChannel } from './channels/telegram.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { Channel } from './channels/types.js';
import { getMetrics, errorMiddleware } from '../monitoring.js';
import { getServiceStatuses } from '../orchestrator.js';
import http from 'http';

const logger = createLogger('server');

const channels: Channel[] = [];

export { channels };

export async function startServer(options: {
  enableChannels?: boolean;
} = {}): Promise<ServiceHandle> {
  const root = getRoot();
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

  // Serve web UI static files BEFORE auth (browsers don't send Bearer tokens on page loads)
  mountWebUi(app, '');

  // Mount all agent routes via shared agent-router (authenticated)
  app.use('/', authMiddleware, createAgentRouter(root, channels));

  // Start channels if configured
  if (options.enableChannels !== false) {
    try {
      const identity = getIdentity();

      if (identity.channels?.telegram?.bot_token) {
        const telegram = new TelegramChannel(identity.channels.telegram, root);
        await telegram.start();
        channels.push(telegram);
      }

      if (identity.channels?.whatsapp?.enabled) {
        const whatsapp = new WhatsAppChannel(root);
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

  return new Promise((resolve, reject) => {
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${port} is already in use. Another agent or process is running on this port.`);
        reject(new Error(`Port ${port} is already in use. Stop the other agent first, or change server.port in identity.yaml.`));
      } else {
        reject(error);
      }
    });

    const bind = resolveBindHost();
    server.listen(port, bind.host, () => {
      logger.info(`Server listening on ${bind.host}:${port}`);

      const hasToken = Boolean(process.env.KYBERBOT_API_TOKEN);
      if (hasToken) {
        logger.info('API authentication enabled');
      } else if (bind.exposed) {
        logger.warn(`API authentication DISABLED and bound to ${bind.host} — brain endpoints are reachable on every interface this host exposes. Set KYBERBOT_API_TOKEN in .env, or unset KYBERBOT_BIND_HOST to revert to loopback-only.`);
      } else {
        logger.info('API authentication disabled — loopback-only (127.0.0.1)');
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
