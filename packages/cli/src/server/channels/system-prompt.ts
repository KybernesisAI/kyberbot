/**
 * KyberBot — Channel System Prompt Builder
 *
 * Builds the system prompt for messaging channels (Telegram, WhatsApp).
 * Loads the agent's full operational context so channel sessions have the
 * same capabilities as terminal sessions — skills, heartbeat, brain, etc.
 *
 * Cross-channel context: recent timeline events from ALL channels
 * (terminal, telegram, whatsapp, heartbeat) are included so the agent
 * has awareness of what happened in other sessions.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getAgentName, getAgentNameForRoot, getRoot, isFleetMode } from '../../config.js';
import { loadInstalledSkills } from '../../skills/loader.js';
import { loadInstalledAgents } from '../../agents/loader.js';
import { getRecentActivity } from '../../brain/timeline.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('system-prompt');

// Fleet bus reference — set by AgentRuntime when running in fleet mode.
// We keep the bus, not a precomputed string, so each system-prompt build
// regenerates awareness fresh for the requesting agent. This is correct
// in fleet mode where multiple agents share this process and a global
// string would be overwritten by whichever agent started last.
let _fleetBus: import('../../runtime/agent-bus.js').AgentBus | null = null;
let _pendingNotificationsGetter: ((agentName: string) => Array<{ from: string; topic?: string; payload: string }>) | null = null;

export function setFleetBus(bus: import('../../runtime/agent-bus.js').AgentBus): void { _fleetBus = bus; }
export function setPendingNotificationsGetter(getter: (agentName: string) => Array<{ from: string; topic?: string; payload: string }>): void {
  _pendingNotificationsGetter = getter;
}

/**
 * Build system prompt for a messaging channel.
 * Includes: identity, personality, user context, operational knowledge,
 * and recent cross-channel activity for continuity.
 *
 * `rootArg` is REQUIRED in fleet mode. Without it, both getRoot() and
 * getAgentName() collapse onto whichever agent loaded last in this process
 * — every channel system prompt would carry the wrong agent's identity,
 * SOUL.md, USER.md, CLAUDE.md, and recent-activity injection.
 *
 * Outside fleet mode (terminal/CLI/single-agent), the singleton fallback
 * is the correct behavior and is preserved.
 */
export async function buildChannelSystemPrompt(
  channel: 'telegram' | 'whatsapp' | 'web',
  rootArg?: string,
): Promise<string> {
  if (isFleetMode() && !rootArg) {
    throw new Error(
      'buildChannelSystemPrompt() called in fleet mode without a root. ' +
      'Pass the agent\'s root as the second argument. Refusing to fall back ' +
      'to getRoot()/getAgentName() — that resolves to whichever agent loaded ' +
      'last and produces cross-agent prompt contamination. Caller fix: ' +
      'buildChannelSystemPrompt(channel, this.root).'
    );
  }
  const root = rootArg ?? getRoot();
  const agentName = rootArg ? getAgentNameForRoot(rootArg) : getAgentName();
  const parts: string[] = [];

  // Channel-specific framing
  if (channel === 'web') {
    parts.push(`You are ${agentName}, a personal AI agent. The user is messaging via the KyberBot web interface.`);
    parts.push('You can use rich markdown formatting in responses — the web UI renders markdown with syntax highlighting.');
    parts.push('');
    parts.push('## Memory-First Protocol');
    parts.push('Before responding to ANY message, proactively search your memory:');
    parts.push('1. Run `kyberbot recall "<relevant entity or topic>"` to query the entity graph');
    parts.push('2. Run `kyberbot search "<relevant keywords>"` for semantic search across stored knowledge');
    parts.push('3. Run `kyberbot timeline --today` if the question relates to recent events');
    parts.push('After each response, store important new information: `kyberbot remember "<facts>"`');
    parts.push('The user can see your tool calls in real-time — using recall/search shows that you are drawing on your full memory, not just SOUL.md and USER.md.');
  } else if (channel === 'telegram') {
    parts.push(`You are ${agentName}, a personal AI agent. The user is messaging via Telegram.`);
    parts.push('Keep responses concise — Telegram messages have a 4096 character limit.');
  } else {
    parts.push(`You are ${agentName}, a personal AI agent. The user is messaging via WhatsApp.`);
    parts.push('Keep responses concise and conversational.');
  }

  parts.push('');
  parts.push('You have full tool access — you can run Bash commands, read/write files, and execute kyberbot CLI commands.');
  parts.push('You are the same agent whether the user talks to you in the terminal or via messaging. You have the same capabilities either way.');

  // Load SOUL.md for personality
  try {
    const soulPath = join(root, 'SOUL.md');
    if (existsSync(soulPath)) {
      const soul = readFileSync(soulPath, 'utf-8');
      parts.push('\n## Personality & Values\n' + soul);
    }
  } catch {
    // Non-fatal
  }

  // Load USER.md for user context
  try {
    const userPath = join(root, 'USER.md');
    if (existsSync(userPath)) {
      const user = readFileSync(userPath, 'utf-8');
      parts.push('\n## About the User\n' + user);
    }
  } catch {
    // Non-fatal
  }

  // Load CLAUDE.md for operational knowledge
  try {
    const claudeMdPath = join(root, '.claude', 'CLAUDE.md');
    if (existsSync(claudeMdPath)) {
      let claudeMd = readFileSync(claudeMdPath, 'utf-8');

      // Strip sections that are only relevant to terminal sessions
      // (First Run, Identity — already covered by SOUL.md/USER.md above)
      claudeMd = stripSection(claudeMd, '## Identity');
      claudeMd = stripSection(claudeMd, '## First Run');

      parts.push('\n## Operational Manual\n' + claudeMd);
    }
  } catch (err) {
    logger.debug('Failed to load CLAUDE.md for channel prompt', { error: String(err) });
  }

  // Load installed skills dynamically (always current, unlike CLAUDE.md which may be stale)
  try {
    const skills = loadInstalledSkills();
    if (skills.length > 0) {
      parts.push('\n## Installed Skills\n');
      parts.push('These skills are available. When the user asks about something a skill handles, **use that skill** — read its full instructions at `skills/<name>/SKILL.md` and follow them.\n');
      for (const skill of skills) {
        parts.push(`- **${skill.name}**: ${skill.description}`);
      }
      parts.push('');
    }
  } catch (err) {
    logger.debug('Failed to load skills for channel prompt', { error: String(err) });
  }

  // Skill creation guidance — always included so the agent creates skills, not ad-hoc scripts
  parts.push('\n## Creating New Skills\n');
  parts.push('When the user asks for a recurring or reusable capability that no existing skill handles:');
  parts.push('');
  parts.push('1. **Read the skill template** at `.claude/skills/templates/skill-template.md` — follow the exact format');
  parts.push('2. **Read the heartbeat-task skill** at `skills/heartbeat-task/SKILL.md` if the task is recurring — follow its full setup workflow (clarify, resolve delivery, resolve credentials, create skill, register heartbeat, test, confirm)');
  parts.push('3. **Create the skill** at `skills/<name>/SKILL.md`');
  parts.push('4. Run `kyberbot skill rebuild` to register it');
  parts.push('5. Execute the task immediately');
  parts.push('');
  parts.push('### SKILL.md Required Format');
  parts.push('');
  parts.push('```yaml');
  parts.push('---');
  parts.push('name: skill-name');
  parts.push('description: "What this skill does. Use when [specific scenarios]. Also use when the user says [trigger phrases]."');
  parts.push('allowed-tools: Bash(specific-command *), Read, Write, Edit');
  parts.push('---');
  parts.push('```');
  parts.push('');
  parts.push('Required sections: `## When to Use`, `## Implementation` (with numbered Steps), `## Examples` (with concrete bash commands).');
  parts.push('');
  parts.push('**Do NOT invent frontmatter fields.** Only use: `name`, `description`, `allowed-tools`, `version`.');
  parts.push('');
  parts.push('### HEARTBEAT.md Task Format');
  parts.push('');
  parts.push('```markdown');
  parts.push('### Task Name');
  parts.push('**Schedule**: every 30m / daily 9am / weekly Monday');
  parts.push('**Window**: 09:00-17:00 (optional)');
  parts.push('**Action**: What the agent should do');
  parts.push('**Skill**: skill-name (references skills/<name>/SKILL.md)');
  parts.push('```');
  parts.push('');
  parts.push('**NEVER create standalone bash scripts in a scripts/ directory.** All reusable capabilities must be skills.');

  // Load installed agents for delegation awareness
  try {
    const agents = loadInstalledAgents();
    if (agents.length > 0) {
      parts.push('\n## Available Sub-Agents\n');
      parts.push('These sub-agents can be spawned for specialized tasks. Delegate when a task benefits from a different perspective or isolated expertise.\n');
      for (const agent of agents) {
        parts.push(`- **${agent.name}** (${agent.model}): ${agent.description} — ${agent.role}`);
      }
      parts.push('');
      parts.push('To spawn a sub-agent: `kyberbot agent spawn <name> "<prompt>"`');
    }
  } catch (err) {
    logger.debug('Failed to load agents for channel prompt', { error: String(err) });
  }

  // Fleet awareness — other running agents and bus commands. Built fresh
  // per-call so each agent sees a correct peer list in fleet mode.
  if (_fleetBus) {
    try {
      const { buildFleetAwarenessSection } = await import('../../runtime/agent-runtime.js');
      const section = buildFleetAwarenessSection(_fleetBus, agentName);
      if (section) parts.push(section);
    } catch { /* runtime not available */ }
  }

  // Pending notifications from other agents (via topic subscriptions)
  if (_pendingNotificationsGetter) {
    try {
      const notifications = _pendingNotificationsGetter(agentName);
      if (notifications.length > 0) {
        parts.push('\n## Pending Notifications from Other Agents\n');
        for (const n of notifications) {
          parts.push(`- **[${n.from}]** (${n.topic || 'general'}): ${n.payload.slice(0, 200)}`);
        }
        parts.push('\nReview these and take action if relevant to the current conversation.\n');
      }
    } catch {}
  }

  // Load recent cross-channel activity for continuity between sessions
  try {
    const recent = await getRecentActivity(root, 15);
    if (recent.length > 0) {
      parts.push('\n## Recent Activity (Cross-Channel)\n');
      parts.push('Recent events from all channels. Use this context to maintain continuity across terminal, Telegram, WhatsApp, and heartbeat sessions.\n');
      for (const event of recent) {
        const time = formatRelativeTime(event.timestamp);
        const summary = event.summary.length > 200
          ? event.summary.slice(0, 197) + '...'
          : event.summary;
        const entities = event.entities.length > 0
          ? ` [${event.entities.slice(0, 5).join(', ')}]`
          : '';
        parts.push(`- ${time} — ${event.title}${entities}`);
        if (summary) {
          parts.push(`  ${summary}`);
        }
      }
    }
  } catch (err) {
    logger.debug('Failed to load cross-channel context', { error: String(err) });
  }

  return parts.join('\n');
}

/**
 * Format an ISO timestamp as a human-readable relative time.
 */
function formatRelativeTime(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(isoTimestamp).toLocaleDateString();
}

/**
 * Strip a markdown section (from heading to next same-level heading).
 */
function stripSection(content: string, heading: string): string {
  const level = heading.match(/^#+/)?.[0] || '##';
  const regex = new RegExp(
    `${escapeRegex(heading)}\\n[\\s\\S]*?(?=\\n${escapeRegex(level)} |$)`,
    'g'
  );
  return content.replace(regex, '').trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
