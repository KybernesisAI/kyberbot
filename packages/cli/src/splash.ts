/**
 * KyberBot — ASCII Splash Screen
 *
 * Displays the startup banner and service status.
 */

import chalk from 'chalk';
import { ServiceStatus } from './types.js';
import { getAgentName } from './config.js';

const PRIMARY = chalk.hex('#6C5CE7');
const ACCENT = chalk.hex('#00CEC9');
const WARM = chalk.hex('#FDCB6E');
const DIM = chalk.dim;

const KYBERBOT_ASCII = `
 _  __      _               ____        _
| |/ /_   _| |__   ___ _ __| __ )  ___ | |_
| ' /| | | | '_ \\ / _ \\ '__|  _ \\ / _ \\| __|
| . \\| |_| | |_) |  __/ |  | |_) | (_) | |_
|_|\\_\\\\__, |_.__/ \\___|_|  |____/ \\___/ \\__|
      |___/`;

const BORDER_TOP = '╔' + '═'.repeat(60) + '╗';
const BORDER_BOTTOM = '╚' + '═'.repeat(60) + '╝';
const BORDER_SIDE = '║';

function centerText(text: string, width: number = 60): string {
  const stripped = text.replace(/\x1B\[[0-9;]*[mK]/g, '');
  const padding = Math.max(0, Math.floor((width - stripped.length) / 2));
  return ' '.repeat(padding) + text;
}

function padLine(text: string, width: number = 60): string {
  const stripped = text.replace(/\x1B\[[0-9;]*[mK]/g, '');
  const padding = Math.max(0, width - stripped.length);
  return text + ' '.repeat(padding);
}

export function displaySplash(root: string): void {
  console.clear();

  console.log(PRIMARY(BORDER_TOP));
  console.log(PRIMARY(BORDER_SIDE) + ' '.repeat(60) + PRIMARY(BORDER_SIDE));

  const asciiLines = KYBERBOT_ASCII.trim().split('\n');
  for (const line of asciiLines) {
    const centered = centerText(line);
    console.log(PRIMARY(BORDER_SIDE) + ACCENT(padLine(centered)) + PRIMARY(BORDER_SIDE));
  }

  console.log(PRIMARY(BORDER_SIDE) + ' '.repeat(60) + PRIMARY(BORDER_SIDE));

  const tagline = ACCENT('Your AI.') + DIM(' Your rules. Powered by Claude Code.');
  console.log(PRIMARY(BORDER_SIDE) + padLine(centerText(tagline)) + PRIMARY(BORDER_SIDE));

  console.log(PRIMARY(BORDER_SIDE) + ' '.repeat(60) + PRIMARY(BORDER_SIDE));
  console.log(PRIMARY(BORDER_BOTTOM));

  console.log();

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

  console.log(DIM('═'.repeat(64)));
  console.log();
  console.log('  ' + WARM.bold(`${agentName} is ready.`));
  console.log();
  console.log(DIM('═'.repeat(64)));
  console.log();
}
