/**
 * KyberBot — Channel System Prompt Builder
 *
 * Builds the system prompt for messaging channels (Telegram, WhatsApp).
 * Loads the agent's full operational context so channel sessions have the
 * same capabilities as terminal sessions — skills, heartbeat, brain, etc.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getAgentName, getRoot } from '../../config.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('system-prompt');

/**
 * Build system prompt for a messaging channel.
 * Includes: identity, personality, user context, and operational knowledge.
 */
export function buildChannelSystemPrompt(channel: 'telegram' | 'whatsapp'): string {
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

  return parts.join('\n');
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
