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

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from '../logger.js';
import { getIdentityForRoot, getHeartbeatModelForRoot } from '../config.js';
import { getClaudeClient } from '../claude.js';
import { ServiceHandle } from '../types.js';
import { storeConversation } from '../brain/store-conversation.js';
import { getSkill } from '../skills/loader.js';

const logger = createLogger('heartbeat');

let intervalId: NodeJS.Timeout | null = null;
let running = false;
let busy = false;

// Orchestration runs on its own interval, separate from the standard heartbeat.
// This tracks when the last orchestration tick ran per agent.
const lastOrchTick = new Map<string, number>();

function parseIntervalMs(intervalStr: string): number {
  const match = intervalStr.match(/^(\d+)(m|h)$/);
  return match
    ? (match[2] === 'h' ? Number(match[1]) * 60 * 60 * 1000 : Number(match[1]) * 60 * 1000)
    : 60 * 60 * 1000;
}

/**
 * Pull the `### Task Name` + `**Schedule**: ...` pairs out of HEARTBEAT.md.
 * Only tasks in the `## Tasks` section are returned. Schedule is kept as
 * a raw string; `isTaskDue` does the interpretation.
 */
interface ParsedTask { name: string; schedule: string }
function parseHeartbeatTasks(content: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const afterTasks = content.split(/^##\s+Tasks\b/im)[1];
  if (!afterTasks) return tasks;
  const blocks = afterTasks.split(/^###\s+/m).slice(1);
  for (const block of blocks) {
    const nameMatch = block.match(/^([^\n]+)/);
    const scheduleMatch = block.match(/\*\*Schedule\*\*:\s*([^\n]+)/i);
    if (nameMatch && scheduleMatch) {
      tasks.push({ name: nameMatch[1].trim(), schedule: scheduleMatch[1].trim() });
    }
  }
  return tasks;
}

/**
 * Decide whether a parsed task is due given its last-check timestamp.
 * Handles the common schedule phrasings used in HEARTBEAT.md templates:
 * `every Nm|Nh|Nd`, `daily`, `weekly`, `monthly`. Unknown syntax is
 * treated as "may be due" — conservative so we don't silently suppress
 * real work.
 */
function isTaskDue(task: ParsedTask, lastCheckIso: string | undefined, now: Date): boolean {
  if (!lastCheckIso) return true; // Never run — run now
  const lastCheck = new Date(lastCheckIso);
  if (isNaN(lastCheck.getTime())) return true;
  const elapsedMs = now.getTime() - lastCheck.getTime();
  const schedule = task.schedule.toLowerCase();

  const everyMatch = schedule.match(/every\s+(\d+)\s*(m|h|d)\b/);
  if (everyMatch) {
    const n = Number(everyMatch[1]);
    const unit = everyMatch[2];
    const required = n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
    return elapsedMs >= required;
  }

  if (schedule.startsWith('daily')) return elapsedMs >= 24 * 3_600_000;
  if (schedule.startsWith('weekly')) return elapsedMs >= 7 * 24 * 3_600_000;
  if (schedule.startsWith('monthly')) return elapsedMs >= 28 * 24 * 3_600_000;

  // Unrecognized — conservative: treat as due
  return true;
}

export function markBusy(isBusy: boolean): void {
  busy = isBusy;
}

export async function startHeartbeat(root: string): Promise<ServiceHandle> {
  const identity = getIdentityForRoot(root);
  const intervalStr = identity.heartbeat_interval || '1h';
  const intervalMs = parseIntervalMs(intervalStr);
  logger.info(`Heartbeat interval: ${intervalMs / 1000 / 60} minutes`);

  running = true;

  // Initial delay before first tick
  const initialDelay = 5 * 60 * 1000; // 5 minutes
  setTimeout(() => {
    tick(root);
    intervalId = setInterval(() => tick(root), intervalMs);
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

async function tick(root: string): Promise<void> {
  // Skip if user is actively chatting
  if (busy) {
    logger.debug('Skipping heartbeat — user session is active');
    return;
  }

  // Check active hours
  if (!isWithinActiveHours(root)) {
    logger.debug('Outside active hours — skipping');
    return;
  }

  // ── Orchestration heartbeat ─────────────────────────────────────
  // CEO and workers run on the orchestration interval (from settings),
  // which may differ from the standard heartbeat interval (from identity.yaml).
  try {
    const { getCeoAgent, getOrgNode, getOrchestrationSettings, listIssues } = await import('../orchestration/index.js');
    const { runCeoHeartbeat } = await import('../orchestration/ceo-heartbeat.js');
    const { runWorkerHeartbeat } = await import('../orchestration/worker-heartbeat.js');
    const settings = getOrchestrationSettings();

    if (settings.orchestration_enabled) {
      const identity = getIdentityForRoot(root);
      const agentName = identity.agent_name;

      // Check if enough time has passed since last orchestration tick for this agent
      const orchIntervalMs = parseIntervalMs(settings.heartbeat_interval || '1h');
      const lastTick = lastOrchTick.get(agentName) || 0;
      const elapsed = Date.now() - lastTick;

      if (elapsed >= orchIntervalMs) {
        lastOrchTick.set(agentName, Date.now());

        const ceo = getCeoAgent();
        if (ceo && ceo.agent_name === agentName) {
          logger.info(`Running CEO orchestration heartbeat (interval: ${settings.heartbeat_interval})`);
          await runCeoHeartbeat(root, agentName);
        } else {
          const orgNode = getOrgNode(agentName);
          if (orgNode) {
            const todoIssues = listIssues({ assigned_to: agentName, status: ['todo', 'in_progress'] });
            if (todoIssues.length > 0) {
              logger.info(`Worker ${agentName} has ${todoIssues.length} assigned issue(s), running heartbeat`);
              await runWorkerHeartbeat(root, agentName, orgNode.role, orgNode.title || agentName);
            }
          }
        }
      } else {
        logger.debug(`Orchestration tick skipped for ${agentName} — ${Math.round((orchIntervalMs - elapsed) / 1000)}s remaining`);
      }
    }
  } catch {
    // Orchestration not initialized — that's fine, skip
  }

  // ── Standard heartbeat ──────────────────────────────────────────

  // Skip if HEARTBEAT.md doesn't exist or is empty
  const heartbeatPath = join(root, 'HEARTBEAT.md');
  if (!existsSync(heartbeatPath)) {
    logger.debug('No HEARTBEAT.md found — skipping');
    return;
  }

  const content = readFileSync(heartbeatPath, 'utf-8').trim();
  if (!content || !content.includes('## Tasks')) {
    logger.debug('HEARTBEAT.md has no tasks — skipping');
    return;
  }

  // Short-circuit: if no task's Schedule is due yet, skip the Claude
  // invocation entirely. Heartbeat ticks into an empty queue used to
  // still spawn a full (Sonnet) subprocess just to reply HEARTBEAT_OK —
  // token waste for an idle fleet. Conservative: if we can't parse a
  // task's schedule, we assume it may be due so Claude still runs.
  try {
    const stateFileEarly = join(root, 'heartbeat-state.json');
    const stateEarly = existsSync(stateFileEarly)
      ? JSON.parse(readFileSync(stateFileEarly, 'utf-8'))
      : { lastChecks: {} };
    const tasks = parseHeartbeatTasks(content);
    if (tasks.length > 0 && !tasks.some((t) => isTaskDue(t, stateEarly.lastChecks?.[t.name], new Date()))) {
      logger.debug(`Heartbeat skipped — no task due yet (${tasks.length} scheduled)`);
      return;
    }
  } catch (err) {
    // Parse/IO error — fall through to the Claude path; conservative
    logger.debug('Heartbeat due-check errored, proceeding to Claude', { error: String(err) });
  }

  try {
    const stateFile = join(root, 'heartbeat-state.json');
    const state = existsSync(stateFile)
      ? JSON.parse(readFileSync(stateFile, 'utf-8'))
      : { lastChecks: {} };

    // Extract referenced skills from tasks and inline their content
    const skillSections: string[] = [];
    const skillRefs = content.match(/\*\*Skill\*\*:\s*(\S+)/g);
    if (skillRefs) {
      for (const ref of skillRefs) {
        const skillName = ref.replace(/\*\*Skill\*\*:\s*/, '').trim();
        const skill = getSkill(skillName, root);
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

    const promptParts = [
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
      `Timezone: ${getIdentityForRoot(root).timezone || Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    ];

    // Fleet awareness — let heartbeat know about other agents
    try {
      const { getActiveBus } = await import('../runtime/agent-bus.js');
      const { buildFleetAwarenessSection } = await import('../runtime/agent-runtime.js');
      const bus = getActiveBus();
      if (bus) {
        const agentName = getIdentityForRoot(root).agent_name || 'KyberBot';
        const fleetSection = buildFleetAwarenessSection(bus, agentName);
        if (fleetSection) promptParts.push('', fleetSection);

        // Pending notifications from other agents
        const notifications = bus.getPendingNotifications(agentName);
        if (notifications.length > 0) {
          promptParts.push('', '## Pending Notifications from Other Agents', '');
          for (const n of notifications) {
            promptParts.push(`- **[${n.from}]** (${(n as any).topic || 'general'}): ${n.payload.slice(0, 200)}`);
          }
          promptParts.push('', 'Review these and take action if relevant.');
        }
      }
    } catch { /* not in fleet mode */ }

    // Worker orchestration context — inject assigned issues and tools
    try {
      const { getOrgNode } = await import('../orchestration/index.js');
      const { getWorkerOrchestrationContext } = await import('../orchestration/worker-heartbeat.js');
      const agentName = getIdentityForRoot(root).agent_name || 'KyberBot';
      const orgNode = getOrgNode(agentName);
      if (orgNode && !orgNode.is_ceo) {
        const orchContext = getWorkerOrchestrationContext(agentName);
        if (orchContext) promptParts.push(orchContext);
      }
    } catch { /* orchestration not initialized */ }

    const prompt = promptParts.join('\n');

    const client = getClaudeClient();
    const result = await client.complete(prompt, {
      maxTurns: 15,
      subprocess: true,
      model: getHeartbeatModelForRoot(root),
      system: [
        'You are a heartbeat task executor for a KyberBot agent.',
        'You have full tool access — you can run Bash commands, read/write files, and make HTTP requests.',
        'When a task references a **Skill**, follow the skill instructions exactly as written.',
        'Execute only the single most overdue task, then stop.',
        'If nothing needs attention, reply HEARTBEAT_OK.',
      ].join(' '),
    });

    // Process orchestration tool calls from worker agents
    try {
      const { getOrgNode } = await import('../orchestration/index.js');
      const { processWorkerToolCalls } = await import('../orchestration/worker-heartbeat.js');
      const agentName = getIdentityForRoot(root).agent_name || 'KyberBot';
      const orgNode = getOrgNode(agentName);
      if (orgNode && !orgNode.is_ceo) {
        processWorkerToolCalls(result, agentName);
      }
    } catch { /* orchestration not initialized */ }

    // Suppress HEARTBEAT_OK
    if (result.trim() === 'HEARTBEAT_OK') {
      logger.debug('Heartbeat: nothing actionable');
    } else {
      logger.info('Heartbeat result:', { result: result.substring(0, 200), heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) });

      // Log to heartbeat log
      const heartbeatLog = join(root, 'logs', 'heartbeat.log');
      const logDir = dirname(heartbeatLog);
      mkdirSync(logDir, { recursive: true });
      appendFileSync(
        heartbeatLog,
        `\n--- ${new Date().toISOString()} ---\n${result}\n`,
        'utf-8'
      );

      // Fire-and-forget: store heartbeat result in memory
      storeConversation(root, {
        prompt: 'Heartbeat task execution',
        response: result,
        channel: 'heartbeat',
      }).catch((err) => logger.warn('Memory storage failed', { error: String(err) }));
    }
  } catch (error) {
    logger.error('Heartbeat tick failed', { error: String(error) });
  }
}

function isWithinActiveHours(root: string): boolean {
  try {
    const identity = getIdentityForRoot(root);
    const activeHours = identity.heartbeat_active_hours;

    if (!activeHours) return true; // No restriction

    const tz = activeHours.timezone || identity.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
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
