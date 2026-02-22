/**
 * KyberBot — Heartbeat Service
 *
 * Internal interval timer that reads HEARTBEAT.md and executes
 * the most overdue task. Inspired by OpenClaw's Gateway heartbeat.
 *
 * - Default interval: 30 minutes (configurable via identity.yaml)
 * - Lane-based queuing: skips if user is actively chatting
 * - HEARTBEAT_OK suppression: silent when nothing actionable
 * - Logs to logs/heartbeat.log
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from '../logger.js';
import { getHeartbeatInterval, getIdentity, paths, getTimezone } from '../config.js';
import { getClaudeClient } from '../claude.js';
import { ServiceHandle } from '../types.js';

const logger = createLogger('heartbeat');

let intervalId: NodeJS.Timeout | null = null;
let running = false;
let busy = false;

export function markBusy(isBusy: boolean): void {
  busy = isBusy;
}

export async function startHeartbeat(): Promise<ServiceHandle> {
  const intervalMs = getHeartbeatInterval();
  logger.info(`Heartbeat interval: ${intervalMs / 1000 / 60} minutes`);

  running = true;

  // Initial delay before first tick
  const initialDelay = 5 * 60 * 1000; // 5 minutes
  setTimeout(() => {
    tick();
    intervalId = setInterval(tick, intervalMs);
  }, initialDelay);

  return {
    stop: async () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      running = false;
    },
    status: () => (running ? 'running' : 'stopped'),
  };
}

async function tick(): Promise<void> {
  // Skip if user is actively chatting
  if (busy) {
    logger.debug('Skipping heartbeat — user session is active');
    return;
  }

  // Skip if HEARTBEAT.md doesn't exist or is empty
  const heartbeatPath = paths.heartbeat;
  if (!existsSync(heartbeatPath)) {
    logger.debug('No HEARTBEAT.md found — skipping');
    return;
  }

  const content = readFileSync(heartbeatPath, 'utf-8').trim();
  if (!content || !content.includes('## Tasks')) {
    logger.debug('HEARTBEAT.md has no tasks — skipping');
    return;
  }

  // Check active hours
  if (!isWithinActiveHours()) {
    logger.debug('Outside active hours — skipping');
    return;
  }

  try {
    const stateFile = paths.heartbeatState;
    const state = existsSync(stateFile)
      ? JSON.parse(readFileSync(stateFile, 'utf-8'))
      : { lastChecks: {} };

    const prompt = [
      'Read HEARTBEAT.md. Follow it strictly.',
      'Check heartbeat-state.json to determine which task is most overdue.',
      'Run only that task. Update heartbeat-state.json when done.',
      'If nothing needs attention, reply HEARTBEAT_OK.',
      '',
      '--- HEARTBEAT.md ---',
      content,
      '',
      '--- heartbeat-state.json ---',
      JSON.stringify(state, null, 2),
      '',
      `Current time: ${new Date().toISOString()}`,
      `Timezone: ${getTimezone()}`,
    ].join('\n');

    const client = getClaudeClient();
    const result = await client.complete(prompt, {
      system: 'You are a heartbeat scheduler. Execute the most overdue task from HEARTBEAT.md. Return HEARTBEAT_OK if nothing needs attention.',
    });

    // Suppress HEARTBEAT_OK
    if (result.trim() === 'HEARTBEAT_OK') {
      logger.debug('Heartbeat: nothing actionable');
    } else {
      logger.info('Heartbeat result:', { result: result.substring(0, 200) });

      // Log to heartbeat log
      const logDir = dirname(paths.heartbeatLog);
      mkdirSync(logDir, { recursive: true });
      appendFileSync(
        paths.heartbeatLog,
        `\n--- ${new Date().toISOString()} ---\n${result}\n`,
        'utf-8'
      );
    }
  } catch (error) {
    logger.error('Heartbeat tick failed', { error: String(error) });
  }
}

function isWithinActiveHours(): boolean {
  try {
    const identity = getIdentity();
    const activeHours = identity.heartbeat_active_hours;

    if (!activeHours) return true; // No restriction

    const tz = activeHours.timezone || getTimezone();
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const timeStr = formatter.format(now);
    const [h, m] = timeStr.split(':').map(Number);
    const currentMinutes = h * 60 + m;

    const [startH, startM] = activeHours.start.split(':').map(Number);
    const startMinutes = startH * 60 + startM;

    const [endH, endM] = activeHours.end.split(':').map(Number);
    const endMinutes = endH * 60 + endM;

    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  } catch {
    return true; // Default to allowing
  }
}
