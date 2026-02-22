/**
 * KyberBot — ASCII Splash Screen
 *
 * Displays the startup banner and service status.
 * Design: emerald green block-letter ASCII, clean layout.
 */

import chalk from 'chalk';
import { ServiceStatus } from './types.js';
import { getAgentName } from './config.js';

// Color palette
const EMERALD = chalk.hex('#50C878');  // Primary — logo, branding
const PRIMARY = chalk.hex('#FF6B6B');  // Warm — ready message, agent name
const DIM = chalk.dim;

const WIDTH = 76;

export function displaySplash(root: string): void {
  console.clear();
  console.log();

  // ASCII logo — emerald gradient (light → deep)
  console.log(chalk.hex('#A8F0C8').bold('  ██╗  ██╗██╗   ██╗██████╗ ███████╗██████╗ ██████╗  ██████╗ ████████╗'));
  console.log(chalk.hex('#82E8A8').bold('  ██║ ██╔╝╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔═══██╗╚══██╔══╝'));
  console.log(chalk.hex('#5CDC88').bold('  █████╔╝  ╚████╔╝ ██████╔╝█████╗  ██████╔╝██████╔╝██║   ██║   ██║'));
  console.log(chalk.hex('#3CCF6E').bold('  ██╔═██╗   ╚██╔╝  ██╔══██╗██╔══╝  ██╔══██╗██╔══██╗██║   ██║   ██║'));
  console.log(chalk.hex('#24C05A').bold('  ██║  ██╗   ██║   ██████╔╝███████╗██║  ██║██████╔╝╚██████╔╝   ██║'));
  console.log(chalk.hex('#10B048').bold('  ╚═╝  ╚═╝   ╚═╝   ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═════╝  ╚═════╝    ╚═╝'));
  console.log();
  console.log(EMERALD('  Your AI.') + DIM(' Your rules. Powered by Claude Code.'));
  console.log();

  // Metadata
  let agentName: string;
  try {
    agentName = getAgentName();
  } catch {
    agentName = 'KyberBot';
  }

  console.log(DIM('  Agent: ') + chalk.white(agentName));
  console.log(DIM('  Root:  ') + chalk.white(root));
  console.log();
}

export function displayServiceStatus(services: ServiceStatus[]): void {
  const maxNameLength = Math.max(...services.map(s => s.name.length));

  for (const service of services) {
    const name = service.name.padEnd(maxNameLength + 2);
    const statusIcon = getStatusIcon(service.status);
    const statusText = getStatusText(service.status);
    const extra = service.extra ? DIM(` ${service.extra}`) : '';

    console.log(`  ${statusIcon} ${name} ${statusText}${extra}`);
  }
  console.log();
}

function getStatusIcon(status: ServiceStatus['status']): string {
  switch (status) {
    case 'running': return chalk.green('✓');
    case 'starting': return chalk.yellow('◐');
    case 'stopped': return chalk.gray('○');
    case 'error': return chalk.red('✗');
    case 'disabled': return chalk.gray('─');
  }
}

function getStatusText(status: ServiceStatus['status']): string {
  switch (status) {
    case 'running': return chalk.green('[RUNNING]');
    case 'starting': return chalk.yellow('[STARTING]');
    case 'stopped': return chalk.gray('[STOPPED]');
    case 'error': return chalk.red('[ERROR]');
    case 'disabled': return chalk.gray('[DISABLED]');
  }
}

export function displayShutdownMessage(): void {
  console.log();
  console.log(DIM('  Shutting down...'));
}

export function displayReadyMessage(): void {
  let agentName: string;
  try {
    agentName = getAgentName();
  } catch {
    agentName = 'KyberBot';
  }

  console.log(DIM('═'.repeat(WIDTH)));
  console.log();
  console.log('  ' + PRIMARY.bold(`${agentName} is ready.`));
  console.log();
  console.log(DIM('═'.repeat(WIDTH)));
  console.log();
}
