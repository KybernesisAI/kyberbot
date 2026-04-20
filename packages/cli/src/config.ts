/**
 * KyberBot — Central Configuration
 *
 * Reads identity.yaml and provides typed access to all config values.
 * Replaces all hardcoded paths and personal data patterns.
 */

import { readFileSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
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
  // Safety: skip directories that look like the kyberbot monorepo source
  // (they contain packages/ alongside identity.yaml from the template)
  let dir = process.cwd();
  let parent = dirname(dir);
  while (dir !== parent) {
    if (existsSync(join(dir, 'identity.yaml'))) {
      // Guard: don't resolve to the monorepo source root
      const isMonorepo = existsSync(join(dir, 'packages', 'cli', 'src'));
      if (!isMonorepo) {
        _root = dir;
        return _root;
      }
    }
    dir = parent;
    parent = dirname(dir);
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
  const interval = getIdentity().heartbeat_interval || '1h';
  return parseDuration(interval);
}

/**
 * Get server port
 */
export function getServerPort(): number {
  return getIdentity().server?.port || 3456;
}

/**
 * Get Claude mode.
 * Config values: 'subscription' | 'sdk'
 * Internal modes: 'agent-sdk' (subscription users), 'sdk' (API key users)
 */
export function getClaudeMode(): 'agent-sdk' | 'sdk' {
  if (process.env.ANTHROPIC_API_KEY) return 'sdk';
  try {
    const configMode = getIdentity().claude?.mode || 'subscription';
    return configMode === 'subscription' ? 'agent-sdk' : 'sdk';
  } catch {
    // Fleet mode: getRoot() fails when cwd is the monorepo, not an agent dir.
    // Default to subscription (agent-sdk) — the universal default.
    return 'agent-sdk';
  }
}

/**
 * Get Kybernesis API key if configured.
 * The API key is tied to a workspace — no agent_id needed.
 */
export function getKybernesisApiKey(): string | null {
  return process.env.KYBERNESIS_API_KEY || null;
}

/**
 * Get preferred Claude model for user-facing conversations
 */
export function getClaudeModel(): string {
  try {
    return getIdentity().claude?.model || 'opus';
  } catch {
    return 'opus';
  }
}

/**
 * Get the model to use for heartbeat (scheduled task execution) and the
 * orchestration CEO/worker heartbeats. Sonnet by default — heartbeat is
 * tool-use orchestration, not deep reasoning. Override with
 * `heartbeat_model: haiku|sonnet|opus` in identity.yaml. Reading from a
 * specific root so fleet-mode callers can resolve the right config.
 */
export function getHeartbeatModelForRoot(root: string): 'haiku' | 'sonnet' | 'opus' {
  try {
    const raw = getIdentityForRoot(root).heartbeat_model;
    if (raw === 'haiku' || raw === 'sonnet' || raw === 'opus') return raw;
  } catch { /* fall through */ }
  return 'sonnet';
}

export function getHeartbeatModel(): 'haiku' | 'sonnet' | 'opus' {
  try {
    const raw = getIdentity().heartbeat_model;
    if (raw === 'haiku' || raw === 'sonnet' || raw === 'opus') return raw;
  } catch { /* fall through */ }
  return 'sonnet';
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
 * Get backup configuration from identity.yaml
 */
export function getBackupConfig() {
  const backup = getIdentity().backup;
  if (!backup?.enabled) return null;
  return {
    enabled: backup.enabled,
    remote_url: backup.remote_url,
    schedule: backup.schedule || '4h',
    branch: backup.branch || 'main',
  };
}

/**
 * Derive the Claude Code project memory path from the agent root.
 * Claude Code stores memory at ~/.claude/projects/-{path-with-slashes-replaced}/memory/
 */
export function getClaudeMemorySourcePath(): string {
  const root = getRoot();
  const projectSlug = root.replace(/\//g, '-');
  const homedir = process.env.HOME || process.env.USERPROFILE || '';
  return join(homedir, '.claude', 'projects', projectSlug, 'memory');
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
  get messagesDb() { return join(getRoot(), 'data', 'messages.db'); },
  get claudeMemory() { return join(getRoot(), 'data', 'claude-memory'); },
  get scripts() { return join(getRoot(), 'scripts'); },
  get heartbeatLog() { return join(getRoot(), 'logs', 'heartbeat.log'); },
};

/**
 * Reset cached config (useful for testing or after config changes)
 */
export function resetConfig(): void {
  _root = null;
  _identity = null;
  identityCache.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PER-ROOT IDENTITY (for multi-agent runtime)
// ═══════════════════════════════════════════════════════════════════════════════

const identityCache = new Map<string, IdentityConfig>();

/**
 * Load identity.yaml for a specific root, with caching.
 * Unlike getIdentity(), this does not depend on the global _root.
 */
export function getIdentityForRoot(root: string): IdentityConfig {
  const cached = identityCache.get(root);
  if (cached) return cached;

  const identityPath = join(root, 'identity.yaml');
  if (!existsSync(identityPath)) {
    throw new Error(`identity.yaml not found at ${identityPath}`);
  }

  const raw = readFileSync(identityPath, 'utf-8');
  const identity = yaml.load(raw) as IdentityConfig;
  identityCache.set(root, identity);
  return identity;
}

export function getAgentNameForRoot(root: string): string {
  return getIdentityForRoot(root).agent_name || 'KyberBot';
}

export function getServerPortForRoot(root: string): number {
  return getIdentityForRoot(root).server?.port || 3456;
}

export function clearIdentityCache(root?: string): void {
  if (root) identityCache.delete(root);
  else identityCache.clear();
}
