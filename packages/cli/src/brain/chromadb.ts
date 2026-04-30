/**
 * KyberBot — ChromaDB Service
 *
 * Manages the ChromaDB Docker container lifecycle.
 * Automatically starts ChromaDB when KyberBot launches.
 * Supports both macOS (Docker Desktop) and Linux (docker daemon).
 */

import { execSync, execFileSync } from 'child_process';
import { join } from 'path';
import { createLogger } from '../logger.js';
import { ServiceHandle } from '../types.js';

const logger = createLogger('chromadb');

const CONTAINER_NAME = 'kyberbot-chromadb';
const DEFAULT_CHROMA_PORT = 8001;

function getChromaPort(): number {
  const envUrl = process.env.CHROMA_URL;
  if (envUrl) {
    try {
      return parseInt(new URL(envUrl).port) || DEFAULT_CHROMA_PORT;
    } catch {
      return DEFAULT_CHROMA_PORT;
    }
  }
  return DEFAULT_CHROMA_PORT;
}

async function isDockerRunning(): Promise<boolean> {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function startDocker(): Promise<boolean> {
  logger.info('Starting Docker...');
  const platform = process.platform;

  try {
    if (platform === 'darwin') {
      // macOS: Start Docker Desktop
      execSync('open -a Docker', { stdio: 'ignore' });
    } else if (platform === 'linux') {
      // Linux: Start docker daemon via systemctl
      try {
        execSync('systemctl start docker', { stdio: 'ignore' });
      } catch {
        // Try with sudo if non-root
        try {
          execSync('sudo systemctl start docker', { stdio: 'ignore' });
        } catch {
          logger.error('Failed to start Docker daemon on Linux. Try: sudo systemctl start docker');
          return false;
        }
      }
    } else {
      logger.error(`Unsupported platform for Docker auto-start: ${platform}`);
      return false;
    }

    // Wait for Docker to be ready (up to 60 seconds)
    const maxWaitMs = 60000;
    const startTime = Date.now();
    const checkInterval = 2000;

    while (Date.now() - startTime < maxWaitMs) {
      if (await isDockerRunning()) {
        logger.info('Docker is ready');
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
      logger.debug('Waiting for Docker...');
    }

    logger.error('Docker failed to start within 60 seconds');
    return false;
  } catch (error) {
    logger.error('Failed to start Docker', { error: String(error) });
    return false;
  }
}

async function isContainerRunning(): Promise<boolean> {
  try {
    const result = execSync(`docker ps --filter "name=${CONTAINER_NAME}" --format "{{.Names}}"`, {
      encoding: 'utf-8',
    });
    return result.trim() === CONTAINER_NAME;
  } catch {
    return false;
  }
}

async function containerExists(): Promise<boolean> {
  try {
    const result = execSync(`docker ps -a --filter "name=${CONTAINER_NAME}" --format "{{.Names}}"`, {
      encoding: 'utf-8',
    });
    return result.trim() === CONTAINER_NAME;
  } catch {
    return false;
  }
}

async function waitForChromaDB(maxWaitMs: number = 30000): Promise<boolean> {
  const startTime = Date.now();
  const checkInterval = 1000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Try v2 API first (newer ChromaDB versions)
      let response = await fetch(`http://localhost:${getChromaPort()}/api/v2/heartbeat`);
      if (response.ok) {
        return true;
      }
      // Fall back to root endpoint
      response = await fetch(`http://localhost:${getChromaPort()}/`);
      if (response.ok) {
        return true;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }
  return false;
}

export async function startChromaDB(rootDir: string): Promise<ServiceHandle> {
  // Check if Docker is running, start it if not
  if (!await isDockerRunning()) {
    logger.info('Docker is not running, attempting to start...');
    const started = await startDocker();
    if (!started) {
      logger.warn('Could not start Docker - ChromaDB disabled');
      return {
        stop: async () => {},
        status: () => 'disabled',
      };
    }
  }

  // Check if container is already running
  if (await isContainerRunning()) {
    logger.info('ChromaDB container already running');

    // Verify it's healthy
    const healthy = await waitForChromaDB(5000);
    if (healthy) {
      logger.info('ChromaDB is healthy');
      return {
        stop: async () => {
          // Don't stop it if it was already running
          logger.info('ChromaDB left running (was already running)');
        },
        status: () => 'running',
      };
    }
  }

  try {
    // Check if container exists
    if (await containerExists()) {
      logger.info('Starting existing ChromaDB container...');
      execSync(`docker start ${CONTAINER_NAME}`, { stdio: 'ignore' });

      // Wait for it to be healthy
      logger.info('Waiting for ChromaDB to be ready...');
      let healthy = await waitForChromaDB(15000);

      if (!healthy) {
        // Container exists but won't start properly - remove and recreate
        logger.warn('Existing container failed, removing and recreating...');
        try {
          execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'ignore' });
        } catch {
          // Ignore removal errors
        }

        // Create new container
        const dataDir = join(rootDir, 'data', 'chromadb');
        logger.info('Creating fresh ChromaDB container...');
        execFileSync('docker', [
          'run', '-d',
          '--name', CONTAINER_NAME,
          '-p', `${getChromaPort()}:8000`,
          '-v', `${dataDir}:/data`,
          '-e', 'IS_PERSISTENT=TRUE',
          '-e', 'ANONYMIZED_TELEMETRY=FALSE',
          'chromadb/chroma:latest',
        ], { stdio: 'pipe' });

        logger.info('Waiting for ChromaDB to be ready...');
        healthy = await waitForChromaDB(45000);
      }

      if (!healthy) {
        logger.error('ChromaDB failed to start');
        return {
          stop: async () => {},
          status: () => 'error',
        };
      }
    } else {
      // Create and start new container
      const dataDir = join(rootDir, 'data', 'chromadb');

      // Pull image first (can take minutes on first run) — don't let docker run block
      logger.info('Pulling ChromaDB image (first time may take a few minutes)...');
      try {
        execFileSync('docker', ['pull', 'chromadb/chroma:latest'], {
          stdio: 'pipe',
          timeout: 300_000, // 5 minutes for image pull
        });
      } catch {
        logger.warn('Docker pull failed or timed out — trying docker run anyway');
      }

      logger.info('Starting ChromaDB container...');
      execFileSync('docker', [
        'run', '-d',
        '--name', CONTAINER_NAME,
        '-p', `${getChromaPort()}:8000`,
        '-v', `${dataDir}:/data`,
        '-e', 'IS_PERSISTENT=TRUE',
        '-e', 'ANONYMIZED_TELEMETRY=FALSE',
        'chromadb/chroma:latest',
      ], { stdio: 'pipe' });

      // Wait for ChromaDB to be healthy
      logger.info('Waiting for ChromaDB to be ready...');
      const healthy = await waitForChromaDB(60000);

      if (!healthy) {
        logger.error('ChromaDB failed to start within 60 seconds');
        return {
          stop: async () => {},
          status: () => 'error',
        };
      }
    }

    logger.info(`ChromaDB ready on port ${getChromaPort()}`);

    return {
      stop: async () => {
        logger.info('Stopping ChromaDB container...');
        try {
          execSync(`docker stop ${CONTAINER_NAME}`, { stdio: 'ignore' });
          logger.info('ChromaDB stopped');
        } catch (error) {
          logger.warn('Failed to stop ChromaDB', { error: String(error) });
        }
      },
      status: () => 'running',
    };
  } catch (error) {
    logger.error('Failed to start ChromaDB', { error: String(error) });
    return {
      stop: async () => {},
      status: () => 'error',
    };
  }
}

export function getChromaDBUrl(): string {
  return `http://localhost:${getChromaPort()}`;
}
