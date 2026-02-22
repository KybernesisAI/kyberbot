/**
 * KyberBot — Unified Logger
 *
 * Provides colored, timestamped logging with service prefixes.
 * All service logs are aggregated and displayed in a unified stream.
 */

import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  service: string;
  message: string;
  data?: unknown;
}

// Service colors for visual distinction
const SERVICE_COLORS: Record<string, (text: string) => string> = {
  'cli': chalk.hex('#FF6B6B'),
  'brain': chalk.hex('#4ECDC4'),
  'sleep': chalk.hex('#95E1D3'),
  'server': chalk.hex('#FFE66D'),
  'heartbeat': chalk.hex('#AA96DA'),
  'channel': chalk.hex('#FCBAD3'),
  'claude': chalk.hex('#A8E6CF'),
  'skills': chalk.hex('#DCD6F7'),
  'default': chalk.hex('#A8D8EA'),
};

const LEVEL_COLORS: Record<LogLevel, (text: string) => string> = {
  debug: chalk.gray,
  info: chalk.blue,
  warn: chalk.yellow,
  error: chalk.red,
};

const LEVEL_ICONS: Record<LogLevel, string> = {
  debug: '·',
  info: '●',
  warn: '▲',
  error: '✗',
};

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function getServiceColor(service: string): (text: string) => string {
  return SERVICE_COLORS[service] || SERVICE_COLORS['default'];
}

function formatTimestamp(date: Date): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatEntry(entry: LogEntry): string {
  const time = chalk.dim(formatTimestamp(entry.timestamp));
  const level = LEVEL_COLORS[entry.level](LEVEL_ICONS[entry.level]);
  const serviceColor = getServiceColor(entry.service);
  const service = serviceColor(`[${entry.service}]`);
  const message = entry.message;

  let output = `${time} ${level} ${service} ${message}`;

  if (entry.data) {
    const dataStr = typeof entry.data === 'object'
      ? JSON.stringify(entry.data, null, 2)
      : String(entry.data);
    output += '\n' + chalk.dim(dataStr);
  }

  return output;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

export class Logger {
  private service: string;

  constructor(service: string) {
    this.service = service;
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (!shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      service: this.service,
      message,
      data,
    };

    const formatted = formatEntry(entry);

    if (level === 'error') {
      console.error(formatted);
    } else {
      console.log(formatted);
    }
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }
}

// Logger factory
const loggers: Map<string, Logger> = new Map();

export function createLogger(service: string): Logger {
  if (!loggers.has(service)) {
    loggers.set(service, new Logger(service));
  }
  return loggers.get(service)!;
}

// Default CLI logger
export const logger = createLogger('cli');
