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
import { getHeartbeatInterval, getIdentity, paths, getTimezone, getRoot } from '../config.js';
import { getClaudeClient } from '../claude.js';
import { ServiceHandle } from '../types.js';
import { storeConversation } from '../brain/store-conversation.js';
import { getSkill } from '../skills/loader.js';

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

    // Extract referenced skills from tasks and inline their content
    const skillSections: string[] = [];
    const skillRefs = content.match(/\*\*Skill\*\*:\s*(\S+)/g);
    if (skillRefs) {
      for (const ref of skillRefs) {
        const skillName = ref.replace(/\*\*Skill\*\*:\s*/, '').trim();
        const skill = getSkill(skillName);
        if (skill) {
          try {
            const skillContent = readFileSync(join(skill.path, 'SKILL.md'), 'utf-8');
            skillSections.push(`--- Skill: ${skillName} (skills/${skillName}/SKILL.md) ---`);
            skillSections.push(skillContent);
            skillSections.push('');
          } catch {
            logger.warn(`Failed to read skill: ${skillName}`);
          }
        }
      }
    }

    const prompt = [
      'You are executing a heartbeat task. Follow these instructions exactly:',
      '',
      '1. Read the HEARTBEAT.md tasks below and the heartbeat-state.json timestamps.',
      '2. Determine which task is most overdue based on its Schedule and last run time.',
      '3. If a task has a **Skill** reference, the full skill instructions are included below — follow them step by step.',
      '4. If a task has no **Skill** reference, execute the **Action** directly.',
      '5. After completing the task, update heartbeat-state.json with the current time.',
      '6. If nothing needs attention, reply with exactly: HEARTBEAT_OK',
      '',
      '--- HEARTBEAT.md ---',
      content,
      '',
      '--- heartbeat-state.json ---',
      JSON.stringify(state, null, 2),
      '',
      ...(skillSections.length > 0 ? skillSections : []),
      `Current time: ${new Date().toISOString()}`,
      `Timezone: ${getTimezone()}`,
    ].join('\n');

    const client = getClaudeClient();
    const result = await client.complete(prompt, {
      maxTurns: 30,
      system: [
        'You are a heartbeat task executor for a KyberBot agent.',
        'You have full tool access — you can run Bash commands, read/write files, and make HTTP requests.',
        'When a task references a **Skill**, follow the skill instructions exactly as written.',
        'Execute only the single most overdue task, then stop.',
        'If nothing needs attention, reply HEARTBEAT_OK.',
      ].join(' '),
    });

    // Suppress HEARTBEAT_OK
    if (result.trim() === 'HEARTBEAT_OK') {
      logger.debug('Heartbeat: nothing actionable');
    } else {
      logger.info('Heartbeat result:', { result: result.substring(0, 200), heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) });

      // Log to heartbeat log
      const logDir = dirname(paths.heartbeatLog);
      mkdirSync(logDir, { recursive: true });
      appendFileSync(
        paths.heartbeatLog,
        `\n--- ${new Date().toISOString()} ---\n${result}\n`,
        'utf-8'
      );

      // Fire-and-forget: store heartbeat result in memory
      storeConversation(getRoot(), {
        prompt: 'Heartbeat task execution',
        response: result,
        channel: 'heartbeat',
      }).catch((err) => logger.warn('Memory storage failed', { error: String(err) }));
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
