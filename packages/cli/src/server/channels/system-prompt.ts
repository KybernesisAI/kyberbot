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
import { getAgentName, getRoot } from '../../config.js';
import { loadInstalledSkills } from '../../skills/loader.js';
import { getRecentActivity } from '../../brain/timeline.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('system-prompt');

/**
 * Build system prompt for a messaging channel.
 * Includes: identity, personality, user context, operational knowledge,
 * and recent cross-channel activity for continuity.
 */
export async function buildChannelSystemPrompt(channel: 'telegram' | 'whatsapp'): Promise<string> {
  const agentName = getAgentName();
  const root = getRoot();
  const parts: string[] = [];

  // Channel-specific framing
  if (channel === 'telegram') {
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
      parts.push('These skills are available. When the user asks about something a skill handles, use that skill instead of guessing or searching memory.\n');
      for (const skill of skills) {
        parts.push(`- **${skill.name}**: ${skill.description}`);
      }
      parts.push('');
      parts.push('To use a skill, read its full instructions at `skills/<name>/SKILL.md` and follow them.');
    }
  } catch (err) {
    logger.debug('Failed to load skills for channel prompt', { error: String(err) });
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
