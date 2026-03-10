/**
 * KyberBot — Agent Loader
 *
 * Discovers and loads installed agents from .claude/agents/.
 * Agents are single .md files (not directories) with YAML frontmatter,
 * matching Claude Code's native agent format.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import yaml from 'js-yaml';
import { paths } from '../config.js';
import { InstalledAgent, AgentManifest } from './types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('agents');

/**
 * Discover all installed agents
 */
export function loadInstalledAgents(): InstalledAgent[] {
  const agentsDir = paths.agents;

  if (!existsSync(agentsDir)) {
    return [];
  }

  const entries = readdirSync(agentsDir, { withFileTypes: true });
  const agents: InstalledAgent[] = [];

  for (const entry of entries) {
    // Agents are single .md files, skip directories (like templates/)
    if (entry.isDirectory()) continue;
    if (!entry.name.endsWith('.md')) continue;

    const agentPath = join(agentsDir, entry.name);

    try {
      const content = readFileSync(agentPath, 'utf-8');
      const parsed = parseAgentFile(content);

      if (!parsed) {
        logger.warn(`Invalid agent manifest: ${entry.name}`);
        continue;
      }

      const { manifest, body } = parsed;
      const agentName = manifest.name || basename(entry.name, '.md');

      agents.push({
        name: agentName,
        description: manifest.description || '',
        role: manifest.role || '',
        path: agentPath,
        model: manifest.model || 'opus',
        maxTurns: manifest['max-turns'] || 10,
        allowedTools: manifest['allowed-tools'] || [],
        systemPromptBody: body,
      });
    } catch (error) {
      logger.warn(`Failed to load agent: ${entry.name}`, { error: String(error) });
    }
  }

  return agents;
}

/**
 * Parse YAML frontmatter + body from an agent .md file
 */
function parseAgentFile(content: string): { manifest: AgentManifest; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/);
  if (!match) return null;

  try {
    const manifest = yaml.load(match[1]) as AgentManifest;
    const body = match[2].trim();
    return { manifest, body };
  } catch {
    return null;
  }
}

/**
 * Get a specific agent by name
 */
export function getAgent(name: string): InstalledAgent | null {
  const agents = loadInstalledAgents();
  return agents.find(a => a.name === name) || null;
}

/**
 * Check if an agent exists
 */
export function hasAgent(name: string): boolean {
  return getAgent(name) !== null;
}
