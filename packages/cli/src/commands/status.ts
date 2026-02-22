/**
 * Status Command
 *
 * Show all services health: ChromaDB, sleep agent, heartbeat,
 * channels, server.
 *
 * Usage:
 *   kyberbot status          # Show service health dashboard
 *   kyberbot status --json   # Machine-readable output
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getRoot, getAgentName } from '../config.js';
import { getServiceStatuses } from '../orchestrator.js';
import { displayServiceStatus } from '../splash.js';
import { ServiceStatus } from '../types.js';

export function createStatusCommand(): Command {
  return new Command('status')
    .description('Show service health dashboard')
    .option('--json', 'Output as JSON', false)
    .action(async (options: { json: boolean }) => {
      try {
        const root = getRoot();

        let agentName: string;
        try {
          agentName = getAgentName();
        } catch {
          agentName = 'KyberBot';
        }

        const statuses: ServiceStatus[] = getServiceStatuses();

        if (options.json) {
          console.log(JSON.stringify({
            agent: agentName,
            root,
            services: statuses,
          }, null, 2));
          return;
        }

        console.log(chalk.bold(`\n${agentName} -- Service Status\n`));

        if (statuses.length === 0) {
          console.log(chalk.dim('  No services registered.'));
          console.log(chalk.dim('  Run `kyberbot run` to start all services.\n'));

          // Still show expected services as stopped
          const expectedServices: ServiceStatus[] = [
            { name: 'ChromaDB', status: 'stopped' },
            { name: 'Server', status: 'stopped' },
            { name: 'Heartbeat', status: 'stopped' },
            { name: 'Sleep Agent', status: 'stopped' },
            { name: 'Channels', status: 'stopped' },
          ];
          displayServiceStatus(expectedServices);
          return;
        }

        displayServiceStatus(statuses);

        // Summary line
        const running = statuses.filter(s => s.status === 'running').length;
        const total = statuses.length;
        const disabled = statuses.filter(s => s.status === 'disabled').length;
        const errors = statuses.filter(s => s.status === 'error').length;

        if (errors > 0) {
          console.log(chalk.red(`  ${errors} service(s) in error state.`));
        }

        console.log(chalk.dim(`  ${running}/${total - disabled} services running${disabled > 0 ? ` (${disabled} disabled)` : ''}`));
        console.log('');
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });
}
