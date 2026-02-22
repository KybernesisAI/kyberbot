/**
 * KyberBot — Service Orchestrator
 *
 * Manages the lifecycle of all background services:
 * - ChromaDB, Server, Heartbeat, Sleep agent, Channels
 */

import { spawn } from 'child_process';
import { createLogger, Logger } from './logger.js';
import { ServiceStatus, ServiceHandle, ServiceConfig } from './types.js';

interface ManagedService {
  config: ServiceConfig;
  handle: ServiceHandle | null;
  logger: Logger;
}

const services: Map<string, ManagedService> = new Map();
const logger = createLogger('cli');

export function registerService(config: ServiceConfig): void {
  services.set(config.name, {
    config,
    handle: null,
    logger: createLogger(config.name),
  });
}

export async function startService(name: string): Promise<boolean> {
  const service = services.get(name);
  if (!service) {
    logger.error(`Service not found: ${name}`);
    return false;
  }

  if (!service.config.enabled) {
    service.logger.info('Service is disabled');
    return true;
  }

  try {
    service.logger.info('Starting...');
    service.handle = await service.config.start();
    service.logger.info('Started successfully');
    return true;
  } catch (error) {
    service.logger.error('Failed to start', { error: String(error) });
    return false;
  }
}

export async function stopService(name: string): Promise<void> {
  const service = services.get(name);
  if (!service || !service.handle) return;

  try {
    service.logger.info('Stopping...');
    await service.handle.stop();
    service.handle = null;
    service.logger.info('Stopped');
  } catch (error) {
    service.logger.error('Error stopping service', { error: String(error) });
  }
}

export async function startAllServices(): Promise<void> {
  logger.info('Starting all services...');

  for (const [name, service] of services) {
    if (service.config.enabled) {
      await startService(name);
    }
  }

  logger.info('All services started');
}

export async function stopAllServices(): Promise<void> {
  logger.info('Stopping all services...');

  const serviceNames = Array.from(services.keys()).reverse();
  for (const name of serviceNames) {
    await stopService(name);
  }

  logger.info('All services stopped');
}

export function getServiceStatuses(): ServiceStatus[] {
  const statuses: ServiceStatus[] = [];

  for (const [_name, service] of services) {
    let status: ServiceStatus['status'] = 'stopped';
    let extra: string | undefined;

    if (!service.config.enabled) {
      status = 'disabled';
    } else if (service.handle) {
      status = service.handle.status();
    }

    statuses.push({
      name: service.config.name,
      status,
      extra,
    });
  }

  return statuses;
}

export function createSubprocessService(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    logger: Logger;
  }
): () => Promise<ServiceHandle> {
  return async () => {
    const { cwd, env, logger } = options;

    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let running = true;

      proc.stdout?.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
          if (line) logger.info(line);
        }
      });

      proc.stderr?.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
          if (line) logger.warn(line);
        }
      });

      proc.on('error', (error) => {
        running = false;
        if (proc.exitCode === null) {
          reject(error);
        }
      });

      proc.on('exit', (code) => {
        running = false;
        if (code !== 0 && code !== null) {
          logger.warn(`Exited with code ${code}`);
        }
      });

      setTimeout(() => {
        if (proc.exitCode === null) {
          resolve({
            stop: async () => {
              if (proc.exitCode === null) {
                proc.kill('SIGTERM');
                await new Promise<void>((res) => {
                  const timeout = setTimeout(() => {
                    proc.kill('SIGKILL');
                    res();
                  }, 5000);
                  proc.on('exit', () => {
                    clearTimeout(timeout);
                    res();
                  });
                });
              }
            },
            status: () => (running ? 'running' : 'stopped'),
          });
        }
      }, 500);
    });
  };
}
