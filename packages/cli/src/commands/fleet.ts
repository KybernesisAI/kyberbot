/**
 * Fleet Command
 *
 * Manage multiple KyberBot agents from a single CLI.
 *
 * Usage:
 *   kyberbot fleet list                      # Show all registered agents
 *   kyberbot fleet register [path]           # Register an agent
 *   kyberbot fleet unregister <name>         # Remove from registry
 *   kyberbot fleet start [--only a,b]        # Start agents as background processes
 *   kyberbot fleet stop [name]               # Stop running agents
 *   kyberbot fleet status                    # Health dashboard
 *   kyberbot fleet defaults --auto-start a,b # Set default auto-start agents
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import yaml from 'js-yaml';
import {
  loadRegistry,
  saveRegistry,
  registerAgent,
  unregisterAgent,
  getRegisteredAgents,
  getAgentNameFromRoot,
  getRegistryDir,
} from '../registry.js';

const PRIMARY = chalk.hex('#10b981');
const ACCENT = chalk.hex('#22d3ee');
const DIM = chalk.dim;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function getPortForRoot(root: string): number {
  try {
    const identityPath = join(root, 'identity.yaml');
    if (!existsSync(identityPath)) return 3456;
    const raw = readFileSync(identityPath, 'utf-8');
    const identity = yaml.load(raw) as Record<string, unknown>;
    const server = identity?.server as Record<string, unknown> | undefined;
    return (server?.port as number) || 3456;
  } catch {
    return 3456;
  }
}

function getPidPath(name: string): string {
  return join(getRegistryDir(), `${name}.pid`);
}

function getRunningPid(name: string): number | null {
  const pidPath = getPidPath(name);
  if (!existsSync(pidPath)) return null;
  try {
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    if (isNaN(pid)) return null;
    // Check if process is actually running
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      // Process not running — stale PID file
      try { unlinkSync(pidPath); } catch { /* ignore */ }
      return null;
    }
  } catch {
    return null;
  }
}

async function probeHealth(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND
// ═══════════════════════════════════════════════════════════════════════════════

export function createFleetCommand(): Command {
  const fleet = new Command('fleet')
    .description('Manage multiple KyberBot agents');

  // ─────────────────────────────────────────────────────────────
  // fleet list
  // ─────────────────────────────────────────────────────────────
  fleet
    .command('list')
    .description('Show all registered agents')
    .action(async () => {
      const agents = getRegisteredAgents();
      const names = Object.keys(agents);

      if (names.length === 0) {
        console.log(DIM('No agents registered. Run `kyberbot fleet register` from an agent directory.'));
        return;
      }

      console.log();
      console.log(PRIMARY.bold('  Registered Agents'));
      console.log();

      // Header
      const nameW = 14;
      const portW = 6;
      const statusW = 10;
      console.log(
        '  ' +
        chalk.bold('Name'.padEnd(nameW)) +
        chalk.bold('Port'.padEnd(portW)) +
        chalk.bold('Status'.padEnd(statusW)) +
        chalk.bold('Root')
      );
      console.log('  ' + '─'.repeat(60));

      for (const name of names) {
        const entry = agents[name];
        const port = getPortForRoot(entry.root);
        const pid = getRunningPid(name);
        const healthy = pid ? await probeHealth(port) : false;

        let status: string;
        if (healthy) {
          status = chalk.green('● running');
        } else if (pid) {
          status = chalk.yellow('● starting');
        } else {
          status = chalk.gray('○ stopped');
        }

        console.log(
          '  ' +
          ACCENT(name.padEnd(nameW)) +
          String(port).padEnd(portW) +
          status.padEnd(statusW + 10) + // extra padding for ANSI codes
          DIM(entry.root)
        );
      }
      console.log();
    });

  // ─────────────────────────────────────────────────────────────
  // fleet register [path]
  // ─────────────────────────────────────────────────────────────
  fleet
    .command('register [path]')
    .description('Register an agent (default: current directory)')
    .action(async (path?: string) => {
      const root = resolve(path || process.cwd());
      const agentName = getAgentNameFromRoot(root);

      if (agentName === 'unknown') {
        console.error(chalk.red(`No identity.yaml found at ${root}`));
        process.exit(1);
      }

      try {
        registerAgent(agentName, root);
        console.log(PRIMARY(`Registered "${agentName}" → ${root}`));
      } catch (error) {
        console.error(chalk.red(`Failed: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────
  // fleet unregister <name>
  // ─────────────────────────────────────────────────────────────
  fleet
    .command('unregister <name>')
    .description('Remove an agent from the registry (files are not deleted)')
    .action(async (name: string) => {
      try {
        unregisterAgent(name);
        console.log(PRIMARY(`Unregistered "${name}". Agent files are untouched.`));
      } catch (error) {
        console.error(chalk.red(`Failed: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────
  // fleet start [--only name1,name2]
  // ─────────────────────────────────────────────────────────────
  fleet
    .command('start')
    .description('Start agents in a shared runtime (single process)')
    .option('--only <names>', 'Comma-separated list of agents to start')
    .option('--port <port>', 'Server port (default: 3456)')
    .action(async (options: { only?: string; port?: string }) => {
      const { FleetManager } = await import('../runtime/fleet-manager.js');
      const { initMonitoring } = await import('../monitoring.js');

      await initMonitoring();

      const port = options.port ? parseInt(options.port) : 3456;
      const names = options.only?.split(',').map((n) => n.trim().toLowerCase());

      const { displayBanner } = await import('../splash.js');
      const { getIdentityForRoot } = await import('../config.js');
      const { getTunnelUrl } = await import('../services/tunnel.js');
      let tunnelUrl: string | null = null;

      console.clear();
      console.log();
      displayBanner('fleet');

      // Fleet metadata
      const agentNames = names || Object.keys((await import('../registry.js')).loadRegistry().agents);
      console.log(DIM('  Mode:    ') + ACCENT('Fleet'));
      console.log(DIM('  Agents:  ') + chalk.white(agentNames.join(', ')));
      console.log(DIM('  Port:    ') + chalk.white(String(port)));
      console.log();

      const fleet = new FleetManager();
      await fleet.loadAgents(names);
      await fleet.start(port);

      // Per-agent status breakdown
      tunnelUrl = getTunnelUrl();
      const statuses = fleet.getAllStatuses();
      console.log();
      for (const status of statuses) {
        const agentIdentity = (() => {
          try { return getIdentityForRoot(status.root); } catch { return null; }
        })();
        const agentPort = agentIdentity?.server?.port || port;
        const agentToken = (() => {
          try {
            const { readFileSync } = require('fs');
            const { join } = require('path');
            const env = readFileSync(join(status.root, '.env'), 'utf-8');
            const match = env.match(/KYBERBOT_API_TOKEN=(.+)/);
            return match ? match[1].trim().replace(/['"]/g, '') : null;
          } catch { return null; }
        })();

        const icon = status.status === 'running' ? chalk.green('✓') : chalk.red('✗');
        const channels = status.services.channels.map(c => c.name).join(', ') || 'none';
        const hasTunnel = agentIdentity?.tunnel?.enabled;

        console.log(`  ${icon} ${ACCENT(status.name.toUpperCase())}`);
        console.log(`    ${DIM('Status:')}    ${status.status === 'running' ? chalk.green('running') : chalk.red(status.status)}`);
        console.log(`    ${DIM('Heartbeat:')} ${status.services.heartbeat}`);
        console.log(`    ${DIM('Channels:')}  ${channels}`);
        console.log(`    ${DIM('Local:')}     http://localhost:${agentPort}`);
        console.log(`    ${DIM('Web UI:')}    http://localhost:${agentPort}/ui`);
        if (hasTunnel && tunnelUrl) {
          console.log(`    ${DIM('Tunnel:')}    ${ACCENT(tunnelUrl)}`);
        }
        if (agentToken) {
          console.log(`    ${DIM('API Key:')}   ${agentToken}`);
        }
        console.log();
      }

      // Fleet connection info
      console.log(DIM('═'.repeat(76)));
      console.log();
      console.log('  ' + PRIMARY.bold('Fleet is ready.'));
      console.log();
      console.log(DIM('═'.repeat(76)));
      console.log();
      console.log(`  ${DIM('Fleet server:')} http://localhost:${port}`);
      for (const s of statuses) {
        console.log(`  ${DIM('Routes:')}       http://localhost:${port}/agent/${s.name}/*`);
      }
      console.log(`  ${DIM('Bus:')}          http://localhost:${port}/fleet/bus/*`);
      console.log();

      // Keep process alive
      await new Promise<void>(() => {});
    });

  // ─────────────────────────────────────────────────────────────
  // fleet stop [name]
  // ─────────────────────────────────────────────────────────────
  fleet
    .command('stop [name]')
    .description('Stop running agents (all if no name given)')
    .action(async (name?: string) => {
      const agents = getRegisteredAgents();
      const toStop = name ? [name.toLowerCase()] : Object.keys(agents);

      let stopped = 0;
      for (const agentName of toStop) {
        const pid = getRunningPid(agentName);
        if (!pid) {
          if (name) {
            console.log(DIM(`${agentName} is not running`));
          }
          continue;
        }

        console.log(`Stopping ${ACCENT(agentName)} (PID ${pid})...`);

        try {
          // SIGTERM for graceful shutdown
          process.kill(pid, 'SIGTERM');

          // Wait up to 10 seconds for process to exit
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            try {
              process.kill(pid, 0); // test if still alive
              await new Promise((r) => setTimeout(r, 500));
            } catch {
              break; // process exited
            }
          }

          // Force kill if still running
          try {
            process.kill(pid, 0);
            process.kill(pid, 'SIGKILL');
            console.log(`  Force-killed ${agentName}`);
          } catch {
            // Already dead
          }

          // Clean up PID file
          const pidPath = getPidPath(agentName);
          try { unlinkSync(pidPath); } catch { /* ignore */ }

          console.log(`  ${PRIMARY('Stopped')} ${agentName}`);
          stopped++;
        } catch (error) {
          console.error(chalk.red(`Failed to stop ${agentName}: ${error}`));
        }
      }

      if (stopped === 0 && !name) {
        console.log(DIM('No agents were running'));
      }
    });

  // ─────────────────────────────────────────────────────────────
  // fleet status
  // ─────────────────────────────────────────────────────────────
  fleet
    .command('status')
    .description('Health dashboard for all agents')
    .action(async () => {
      const agents = getRegisteredAgents();
      const names = Object.keys(agents);

      if (names.length === 0) {
        console.log(DIM('No agents registered.'));
        return;
      }

      console.log();
      console.log(PRIMARY.bold('  Fleet Status'));
      console.log();

      let running = 0;
      let total = 0;

      for (const name of names) {
        total++;
        const entry = agents[name];
        const port = getPortForRoot(entry.root);
        const pid = getRunningPid(name);
        const healthy = pid ? await probeHealth(port) : false;

        if (healthy) running++;

        const statusIcon = healthy ? chalk.green('●') : pid ? chalk.yellow('●') : chalk.gray('○');
        const statusText = healthy ? 'healthy' : pid ? `starting (PID ${pid})` : 'stopped';

        console.log(`  ${statusIcon} ${ACCENT(name.padEnd(14))} ${statusText}`);

        if (healthy) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000);
            const res = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
            clearTimeout(timeout);
            if (res.ok) {
              const health = await res.json() as Record<string, unknown>;
              const services = health.services as Array<{ name: string; status: string }> | undefined;
              if (services) {
                for (const svc of services) {
                  const svcIcon = svc.status === 'running' ? chalk.green('✓') : chalk.gray('–');
                  console.log(`    ${svcIcon} ${svc.name}`);
                }
              }
            }
          } catch { /* ignore */ }
        }
      }

      console.log();
      console.log(`  ${running}/${total} agents running`);
      console.log();
    });

  // ─────────────────────────────────────────────────────────────
  // fleet defaults
  // ─────────────────────────────────────────────────────────────
  fleet
    .command('defaults')
    .description('Set default fleet configuration')
    .option('--auto-start <names>', 'Comma-separated list of agents to start by default')
    .action(async (options: { autoStart?: string }) => {
      const registry = loadRegistry();

      if (options.autoStart) {
        const names = options.autoStart.split(',').map((n) => n.trim().toLowerCase());
        // Validate
        for (const name of names) {
          if (!registry.agents[name]) {
            console.error(chalk.red(`Agent "${name}" not found in registry.`));
            process.exit(1);
          }
        }
        if (!registry.defaults) registry.defaults = {};
        registry.defaults.auto_start = names;
        saveRegistry(registry);
        console.log(PRIMARY(`Auto-start set to: ${names.join(', ')}`));
      } else {
        const autoStart = registry.defaults?.auto_start;
        if (autoStart && autoStart.length > 0) {
          console.log(`Auto-start: ${autoStart.join(', ')}`);
        } else {
          console.log(DIM('No auto-start defaults set. All agents will start with `fleet start`.'));
        }
      }
    });

  return fleet;
}
