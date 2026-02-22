/**
 * KyberBot — Central Configuration
 *
 * Reads identity.yaml and provides typed access to all config values.
 * Replaces all hardcoded paths and personal data patterns.
 */

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import yaml from 'js-yaml';
import { IdentityConfig } from './types.js';

let _root: string | null = null;
let _identity: IdentityConfig | null = null;

/**
 * Get the KyberBot instance root directory.
 * Resolution order:
 *   1. KYBERBOT_ROOT env var
 *   2. Current working directory (if it contains identity.yaml)
 *   3. Throws
 */
export function getRoot(): string {
  if (_root) return _root;

  if (process.env.KYBERBOT_ROOT) {
    _root = resolve(process.env.KYBERBOT_ROOT);
    return _root;
  }

  // Walk up from cwd looking for identity.yaml
  let dir = process.cwd();
  while (dir !== '/') {
    if (existsSync(join(dir, 'identity.yaml'))) {
      _root = dir;
      return _root;
    }
    dir = resolve(dir, '..');
  }

  throw new Error(
    'Could not find KyberBot root. Set KYBERBOT_ROOT or run from a KyberBot instance directory.'
  );
}

/**
 * Load and cache identity.yaml
 */
export function getIdentity(): IdentityConfig {
  if (_identity) return _identity;

  const root = getRoot();
  const identityPath = join(root, 'identity.yaml');

  if (!existsSync(identityPath)) {
    throw new Error(`identity.yaml not found at ${identityPath}. Run 'kyberbot onboard' first.`);
  }

  const raw = readFileSync(identityPath, 'utf-8');
  _identity = yaml.load(raw) as IdentityConfig;
  return _identity;
}

/**
 * Get agent name from identity.yaml
 */
export function getAgentName(): string {
  return getIdentity().agent_name || 'KyberBot';
}

/**
 * Get configured timezone
 */
export function getTimezone(): string {
  return getIdentity().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Get heartbeat interval as milliseconds
 */
export function getHeartbeatInterval(): number {
  const interval = getIdentity().heartbeat_interval || '30m';
  return parseDuration(interval);
}

/**
 * Get server port
 */
export function getServerPort(): number {
  return getIdentity().server?.port || 3456;
}

/**
 * Get Claude mode (subscription or sdk)
 */
export function getClaudeMode(): 'subscription' | 'sdk' {
  if (process.env.ANTHROPIC_API_KEY) return 'sdk';
  return getIdentity().claude?.mode || 'subscription';
}

/**
 * Get preferred Claude model
 */
export function getClaudeModel(): string {
  return getIdentity().claude?.model || 'sonnet';
}

/**
 * Parse a duration string like "30m", "1h", "5m" into milliseconds
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(s|m|h|d)$/);
  if (!match) throw new Error(`Invalid duration: ${duration}`);

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/**
 * Standard paths within a KyberBot instance
 */
export const paths = {
  get root() { return getRoot(); },
  get identity() { return join(getRoot(), 'identity.yaml'); },
  get soul() { return join(getRoot(), 'SOUL.md'); },
  get user() { return join(getRoot(), 'USER.md'); },
  get heartbeat() { return join(getRoot(), 'HEARTBEAT.md'); },
  get heartbeatState() { return join(getRoot(), 'heartbeat-state.json'); },
  get env() { return join(getRoot(), '.env'); },
  get brain() { return join(getRoot(), 'brain'); },
  get skills() { return join(getRoot(), 'skills'); },
  get data() { return join(getRoot(), 'data'); },
  get logs() { return join(getRoot(), 'logs'); },
  get claude() { return join(getRoot(), '.claude'); },
  get claudeMd() { return join(getRoot(), '.claude', 'CLAUDE.md'); },
  get settings() { return join(getRoot(), '.claude', 'settings.local.json'); },
  get agents() { return join(getRoot(), '.claude', 'agents'); },
  get skillGenerator() { return join(getRoot(), '.claude', 'skills', 'skill-generator.md'); },
  get entityDb() { return join(getRoot(), 'data', 'entity-graph.db'); },
  get timelineDb() { return join(getRoot(), 'data', 'timeline.db'); },
  get sleepDb() { return join(getRoot(), 'data', 'sleep.db'); },
  get heartbeatLog() { return join(getRoot(), 'logs', 'heartbeat.log'); },
};

/**
 * Reset cached config (useful for testing or after config changes)
 */
export function resetConfig(): void {
  _root = null;
  _identity = null;
}
