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
import { ServiceHandle } from '../types.js';
import { TelegramChannel } from './channels/telegram.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { Channel } from './channels/types.js';
import http from 'http';

const logger = createLogger('server');

const channels: Channel[] = [];

export async function startServer(options: {
  enableChannels?: boolean;
} = {}): Promise<ServiceHandle> {
  const app = express();
  const port = getServerPort();

  app.use(express.json());

  // Public health endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      channels: channels.map(c => ({ name: c.name, connected: c.isConnected() })),
    });
  });

  // Brain API (authenticated)
  app.use('/brain', authMiddleware, createBrainRouter());

  // Start channels if configured
  if (options.enableChannels !== false) {
    try {
      const identity = getIdentity();

      if (identity.channels?.telegram?.bot_token) {
        const telegram = new TelegramChannel(identity.channels.telegram.bot_token);
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

  const server = http.createServer(app);

  return new Promise((resolve) => {
    server.listen(port, () => {
      logger.info(`Server listening on port ${port}`);

      if (process.env.KYBERBOT_API_TOKEN) {
        logger.info('API authentication enabled');
      } else {
        logger.info('API authentication disabled (set KYBERBOT_API_TOKEN to enable)');
      }

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
