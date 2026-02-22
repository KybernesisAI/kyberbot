/**
 * Run Command
 *
 * Start all 5 KyberBot services in order:
 *   1. ChromaDB check
 *   2. Server (Express + brain API)
 *   3. Heartbeat
 *   4. Sleep Agent
 *   5. Channels (if configured)
 *
 * Usage:
 *   kyberbot                      # Start everything (default command)
 *   kyberbot run                  # Same as above
 *   kyberbot run --no-channels    # Skip channels
 *   kyberbot run --no-sleep       # Skip sleep agent
 *   kyberbot run --no-heartbeat   # Skip heartbeat
 *   kyberbot run -v               # Verbose logging
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getRoot, getAgentName } from '../config.js';
import { createLogger, setLogLevel } from '../logger.js';
import {
  registerService,
  startAllServices,
  stopAllServices,
  getServiceStatuses,
} from '../orchestrator.js';
import {
  displaySplash,
  displayServiceStatus,
  displayReadyMessage,
  displayShutdownMessage,
} from '../splash.js';

const logger = createLogger('cli');

interface RunOptions {
  channels: boolean;
  sleep: boolean;
  heartbeat: boolean;
  verbose: boolean;
}

export function createRunCommand(): Command {
  return new Command('run')
    .description('Start all KyberBot services')
    .option('--no-channels', 'Disable messaging channels')
    .option('--no-sleep', 'Disable sleep agent')
    .option('--no-heartbeat', 'Disable heartbeat service')
    .option('-v, --verbose', 'Enable verbose (debug) logging', false)
    .action(async (options: RunOptions) => {
      try {
        const root = getRoot();

        if (options.verbose) {
          setLogLevel('debug');
        }

        // Show splash screen
        displaySplash(root);

        // ─────────────────────────────────────────────────────────────
        // Service 1: ChromaDB check
        // ─────────────────────────────────────────────────────────────

        registerService({
          name: 'ChromaDB',
          enabled: true,
          start: async () => {
            // Start the Docker container first, then initialize embeddings
            const { startChromaDB } = await import('../brain/chromadb.js');
            const handle = await startChromaDB(root);
            const chromaStatus = handle.status();

            if (chromaStatus === 'running' || chromaStatus === 'disabled') {
              // Container is up (or Docker unavailable) — now try embeddings
              const { initializeEmbeddings } = await import('../brain/embeddings.js');
              const embeddingsOk = await initializeEmbeddings();
              return {
                stop: handle.stop,
                status: () => embeddingsOk ? 'running' as const : handle.status() as 'running' | 'disabled' | 'error',
              };
            }

            return handle;
          },
        });

        // ─────────────────────────────────────────────────────────────
        // Service 2: Server (Express + brain API + channels)
        // ─────────────────────────────────────────────────────────────

        registerService({
          name: 'Server',
          enabled: true,
          start: async () => {
            const { startServer } = await import('../server/index.js');
            return startServer();
          },
        });

        // ─────────────────────────────────────────────────────────────
        // Service 3: Heartbeat
        // ─────────────────────────────────────────────────────────────

        registerService({
          name: 'Heartbeat',
          enabled: options.heartbeat,
          start: async () => {
            const { startHeartbeat } = await import('../services/heartbeat.js');
            return startHeartbeat();
          },
        });

        // ─────────────────────────────────────────────────────────────
        // Service 4: Sleep Agent
        // ─────────────────────────────────────────────────────────────

        registerService({
          name: 'Sleep Agent',
          enabled: options.sleep,
          start: async () => {
            const { startSleepAgent } = await import('../brain/sleep/index.js');
            return startSleepAgent(root);
          },
        });

        // ─────────────────────────────────────────────────────────────
        // Service 5: Channels
        // ─────────────────────────────────────────────────────────────

        registerService({
          name: 'Channels',
          enabled: options.channels,
          start: async () => {
            // Channels are initialized as part of the server startup.
            // This entry exists for visibility in the service dashboard.
            let running = true;
            return {
              stop: async () => { running = false; },
              status: () => running ? 'running' as const : 'stopped' as const,
            };
          },
        });

        // ─────────────────────────────────────────────────────────────
        // Start all registered services
        // ─────────────────────────────────────────────────────────────

        await startAllServices();

        // Display status dashboard
        const statuses = getServiceStatuses();
        displayServiceStatus(statuses);
        displayReadyMessage();

        // ─────────────────────────────────────────────────────────────
        // Graceful shutdown on SIGINT / SIGTERM
        // ─────────────────────────────────────────────────────────────

        let shuttingDown = false;

        const shutdown = async (signal: string) => {
          if (shuttingDown) return;
          shuttingDown = true;

          displayShutdownMessage();
          logger.info(`Received ${signal}, shutting down...`);

          await stopAllServices();
          process.exit(0);
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));

        // Keep the process alive indefinitely
        await new Promise<void>(() => {
          // The process stays alive until a signal is received
        });
      } catch (error) {
        logger.error('Failed to start', { error: String(error) });
        console.error(chalk.red(`\nFailed to start: ${error}`));
        console.error(chalk.dim('\nMake sure you have run `kyberbot onboard` first.'));
        process.exit(1);
      }
    });
}
