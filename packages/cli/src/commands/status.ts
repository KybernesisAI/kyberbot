/**
 * Status Command
 *
 * Probes live services to show actual health status.
 * Works from any process — doesn't need to be the running server.
 *
 * Usage:
 *   kyberbot status          # Show service health dashboard
 *   kyberbot status --json   # Machine-readable output
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { getRoot, getAgentName, getServerPort } from '../config.js';
import { displayServiceStatus } from '../splash.js';
import { ServiceStatus } from '../types.js';

async function probeHttp(url: string, timeoutMs: number = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

function probeDockerContainer(name: string): boolean {
  try {
    const result = execSync(`docker ps --filter "name=${name}" --format "{{.Names}}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return result.trim() === name;
  } catch {
    return false;
  }
}

export function createStatusCommand(): Command {
  return new Command('status')
    .description('Show service health dashboard')
    .option('--json', 'Output as JSON', false)
    .action(async (options: { json: boolean }) => {
      try {
        const root = getRoot();
        const port = getServerPort();

        let agentName: string;
        try {
          agentName = getAgentName();
        } catch {
          agentName = 'KyberBot';
        }

        // Probe all services in parallel
        const chromaPort = process.env.CHROMA_URL
          ? new URL(process.env.CHROMA_URL).port
          : '8001';

        const [serverUp, chromaUp] = await Promise.all([
          probeHttp(`http://localhost:${port}/health`),
          probeHttp(`http://localhost:${chromaPort}/`),
        ]);

        const chromaContainer = probeDockerContainer('kyberbot-chromadb');
        const sleepDbExists = existsSync(join(root, 'data', 'sleep.db'));
        const heartbeatExists = existsSync(join(root, 'HEARTBEAT.md'));

        const statuses: ServiceStatus[] = [
          {
            name: 'ChromaDB',
            status: chromaUp ? 'running' : chromaContainer ? 'starting' : 'stopped',
            extra: chromaUp ? `port ${chromaPort}` : undefined,
          },
          {
            name: 'Server',
            status: serverUp ? 'running' : 'stopped',
            extra: serverUp ? `port ${port}` : undefined,
          },
          {
            name: 'Heartbeat',
            status: serverUp && heartbeatExists ? 'running' : 'stopped',
          },
          {
            name: 'Sleep Agent',
            status: serverUp && sleepDbExists ? 'running' : 'stopped',
          },
          {
            name: 'Channels',
            status: serverUp ? 'running' : 'stopped',
          },
        ];

        if (options.json) {
          console.log(JSON.stringify({
            agent: agentName,
            root,
            services: statuses,
          }, null, 2));
          return;
        }

        console.log(chalk.bold(`\n${agentName} -- Service Status\n`));
        displayServiceStatus(statuses);

        // Summary line
        const running = statuses.filter(s => s.status === 'running').length;
        const total = statuses.length;

        if (running === 0) {
          console.log(chalk.dim('  All services offline. Run `kyberbot` to start.'));
        } else {
          console.log(chalk.dim(`  ${running}/${total} services running`));
        }
        console.log('');
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });
}
