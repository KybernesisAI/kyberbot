/**
 * KyberBot — Agent Registry
 *
 * Manages a global registry of KyberBot agents at ~/.kyberbot/registry.yaml.
 * Used by `kyberbot fleet` CLI and the desktop app to discover and manage agents.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import yaml from 'js-yaml';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentEntry {
  root: string;
  registered: string; // ISO timestamp
}

export interface Registry {
  agents: Record<string, AgentEntry>;
  defaults?: {
    auto_start?: string[];
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PATHS
// ═══════════════════════════════════════════════════════════════════════════════

export function getRegistryDir(): string {
  const dir = join(homedir(), '.kyberbot');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getRegistryPath(): string {
  return join(getRegistryDir(), 'registry.yaml');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════════════════════════════

export function loadRegistry(): Registry {
  const path = getRegistryPath();
  if (!existsSync(path)) {
    return { agents: {} };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = yaml.load(raw) as Registry | null;
    if (!parsed || typeof parsed !== 'object') {
      return { agents: {} };
    }
    return { agents: parsed.agents || {}, defaults: parsed.defaults };
  } catch {
    return { agents: {} };
  }
}

export function saveRegistry(registry: Registry): void {
  const path = getRegistryPath();
  getRegistryDir(); // ensure dir exists
  writeFileSync(path, yaml.dump(registry, { lineWidth: 120 }), 'utf-8');
}

export function registerAgent(name: string, root: string): void {
  const resolvedRoot = resolve(root);

  // Validate the root has an identity.yaml
  const identityPath = join(resolvedRoot, 'identity.yaml');
  if (!existsSync(identityPath)) {
    throw new Error(`No identity.yaml found at ${resolvedRoot}. Is this a KyberBot agent directory?`);
  }

  // Read agent name from identity.yaml if not provided or use the given name
  const sanitizedName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  if (!sanitizedName) {
    throw new Error('Agent name cannot be empty');
  }

  const registry = loadRegistry();
  registry.agents[sanitizedName] = {
    root: resolvedRoot,
    registered: new Date().toISOString(),
  };
  saveRegistry(registry);
}

export function unregisterAgent(name: string): void {
  const sanitizedName = name.toLowerCase();
  const registry = loadRegistry();

  if (!registry.agents[sanitizedName]) {
    throw new Error(`Agent "${name}" is not registered`);
  }

  delete registry.agents[sanitizedName];

  // Remove from auto_start if present
  if (registry.defaults?.auto_start) {
    registry.defaults.auto_start = registry.defaults.auto_start.filter(
      (n) => n !== sanitizedName
    );
  }

  saveRegistry(registry);
}

export function getRegisteredAgents(): Record<string, AgentEntry> {
  return loadRegistry().agents;
}

export function resolveAgentRoot(nameOrPath: string): string {
  // If it looks like a path, resolve it
  if (nameOrPath.includes('/') || nameOrPath.startsWith('~') || nameOrPath.startsWith('.')) {
    const resolved = nameOrPath.startsWith('~')
      ? join(homedir(), nameOrPath.slice(1))
      : resolve(nameOrPath);
    return resolved;
  }

  // Otherwise, look up by name in registry
  const registry = loadRegistry();
  const entry = registry.agents[nameOrPath.toLowerCase()];
  if (!entry) {
    throw new Error(`Agent "${nameOrPath}" not found in registry. Run \`kyberbot fleet register\` first.`);
  }
  return entry.root;
}

export function isRegistered(name: string): boolean {
  const registry = loadRegistry();
  return name.toLowerCase() in registry.agents;
}

/**
 * Find the next available port for a new agent.
 * Scans all registered agents' ports and returns the next unused one.
 * Starts from 3456 and increments.
 */
export function getNextAvailablePort(): number {
  const registry = loadRegistry();
  const usedPorts = new Set<number>();

  for (const [, entry] of Object.entries(registry.agents)) {
    try {
      const identityPath = join(entry.root, 'identity.yaml');
      if (existsSync(identityPath)) {
        const raw = readFileSync(identityPath, 'utf-8');
        const identity = yaml.load(raw) as Record<string, unknown>;
        const server = identity?.server as Record<string, unknown> | undefined;
        const port = (server?.port as number) || 3456;
        usedPorts.add(port);
      }
    } catch { /* skip */ }
  }

  let port = 3456;
  while (usedPorts.has(port)) {
    port++;
  }
  return port;
}

/**
 * Get the agent name from identity.yaml at the given root.
 */
export function getAgentNameFromRoot(root: string): string {
  const identityPath = join(root, 'identity.yaml');
  if (!existsSync(identityPath)) {
    return 'unknown';
  }
  try {
    const raw = readFileSync(identityPath, 'utf-8');
    const identity = yaml.load(raw) as Record<string, unknown>;
    return (identity?.agent_name as string) || 'unknown';
  } catch {
    return 'unknown';
  }
}
