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

/**
 * Fetch the live orchestrator's service registry via /health. Returns null if
 * the server isn't reachable — caller falls back to filesystem heuristics.
 * The live registry is authoritative: it knows which services were actually
 * registered (e.g. Arcana, Watched Folders) and whether --no-X flags
 * disabled them at boot, neither of which heuristics can tell.
 */
async function fetchLiveServices(port: number): Promise<ServiceStatus[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = await response.json() as { services?: Array<{ name: string; status: ServiceStatus['status'] }> };
    if (!Array.isArray(body.services)) return null;
    return body.services.map(s => ({ name: s.name, status: s.status }));
  } catch {
    return null;
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

        const [serverUp, chromaUp, liveServices] = await Promise.all([
          probeHttp(`http://localhost:${port}/health`),
          probeHttp(`http://localhost:${chromaPort}/api/v2/heartbeat`),
          fetchLiveServices(port),
        ]);

        let statuses: ServiceStatus[];

        if (liveServices) {
          // Authoritative: orchestrator's live registry. Includes Arcana,
          // Watched Folders, and honours --no-* boot flags.
          const chromaPortStr = chromaUp ? `port ${chromaPort}` : undefined;
          statuses = liveServices.map(s => ({
            ...s,
            extra: s.name === 'ChromaDB' ? chromaPortStr
                 : s.name === 'Server' ? `port ${port}`
                 : undefined,
          }));
        } else {
          // Fallback: server not reachable, guess from filesystem evidence.
          // Inherently approximate — sleep.db existing doesn't mean sleep is
          // running right now, just that it has run at some point.
          const chromaContainer = probeDockerContainer('kyberbot-chromadb');
          const sleepDbExists = existsSync(join(root, 'data', 'sleep.db'));
          const heartbeatExists = existsSync(join(root, 'HEARTBEAT.md'));
          const arcanaDbExists = existsSync(join(root, 'data', 'arcana.db'));

          statuses = [
            {
              name: 'ChromaDB',
              status: chromaUp ? 'running' : chromaContainer ? 'starting' : 'stopped',
              extra: chromaUp ? `port ${chromaPort}` : undefined,
            },
            {
              name: 'Arcana',
              status: arcanaDbExists ? 'stopped' : 'stopped',
              extra: arcanaDbExists ? 'db exists, server offline' : undefined,
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
        }

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
