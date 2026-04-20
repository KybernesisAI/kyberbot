/**
 * KyberBot — Skill Registry
 *
 * Tracks installed skills and rebuilds CLAUDE.md when skills change.
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { paths, getAgentName, getHeartbeatInterval, getKybernesisApiKey, getAgentNameForRoot, getIdentityForRoot } from '../config.js';
import { loadInstalledSkills } from './loader.js';
import { InstalledSkill } from './types.js';
import { loadInstalledAgents } from '../agents/loader.js';
import { buildAgentSection } from '../agents/registry.js';
import { createLogger } from '../logger.js';

const logger = createLogger('skills');

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the source template CLAUDE.md from the KyberBot source repo.
 * Falls back to the instance's .claude/CLAUDE.md if source is unavailable.
 */
function resolveTemplatePath(): string {
  // __dirname = <monorepo>/packages/cli/dist/skills
  const sourceTemplate = join(__dirname, '..', '..', '..', '..', 'template', '.claude', 'CLAUDE.md');
  if (existsSync(sourceTemplate)) {
    return sourceTemplate;
  }
  // Fallback: read from instance (markers may already be consumed)
  return join(paths.root, '.claude', 'CLAUDE.md');
}

/**
 * Rebuild the CLAUDE.md file with current skill and agent information.
 * Always starts from the source template to ensure markers are present.
 * If root is provided, uses that agent's directory (multi-agent safe).
 */
export function rebuildClaudeMd(root?: string): void {
  const templatePath = resolveTemplatePath();

  if (!existsSync(templatePath)) {
    logger.warn('CLAUDE.md template not found');
    return;
  }

  let content = readFileSync(templatePath, 'utf-8');

  // Replace agent name placeholder
  let agentName: string;
  try {
    agentName = root ? getAgentNameForRoot(root) : getAgentName();
  } catch {
    agentName = 'KyberBot';
  }
  content = content.replace(/\{\{AGENT_NAME\}\}/g, agentName);

  // Replace heartbeat interval
  try {
    const intervalMs = root
      ? parseDurationStr(getIdentityForRoot(root).heartbeat_interval || '1h')
      : getHeartbeatInterval();
    const intervalMin = intervalMs / 1000 / 60;
    const intervalStr = intervalMin >= 60 ? `${intervalMin / 60} hour(s)` : `${intervalMin} minutes`;
    content = content.replace(/\{\{HEARTBEAT_INTERVAL\}\}/g, intervalStr);
  } catch {
    content = content.replace(/\{\{HEARTBEAT_INTERVAL\}\}/g, '30 minutes');
  }

  // Strip Kybernesis sections if no API key configured
  if (!getKybernesisApiKey()) {
    content = content.replace(
      /<!-- BEGIN_KYBERNESIS -->[\s\S]*?<!-- END_KYBERNESIS -->\n?/g,
      ''
    );
  } else {
    // Remove the markers, keep the content
    content = content.replace(/<!-- BEGIN_KYBERNESIS -->\n?/g, '');
    content = content.replace(/<!-- END_KYBERNESIS -->\n?/g, '');
  }

  // Insert skill list
  const skills = loadInstalledSkills(root);
  const skillSection = buildSkillSection(skills);
  content = content.replace(
    /<!-- Auto-populated by skill registry -->/,
    skillSection || '*No skills installed yet. The agent will create them as needed.*'
  );

  // Insert agent list
  const agents = loadInstalledAgents(root);
  const agentSection = buildAgentSection(agents);
  content = content.replace(
    /<!-- Auto-populated by agent registry -->/,
    agentSection || '*No agents installed yet. Create one with `kyberbot agent create <name>`.*'
  );

  const claudeMdPath = root ? join(root, '.claude', 'CLAUDE.md') : paths.claudeMd;
  writeFileSync(claudeMdPath, content);
  logger.info(`Rebuilt CLAUDE.md with ${skills.length} skills and ${agents.length} agents`);
}

function parseDurationStr(interval: string): number {
  const match = interval.match(/^(\d+)(m|h|d)$/);
  if (!match) return 30 * 60 * 1000;
  const value = parseInt(match[1]);
  switch (match[2]) {
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return 60 * 60 * 1000;
  }
}

function buildSkillSection(skills: InstalledSkill[]): string {
  if (skills.length === 0) return '';

  const lines = skills.map(skill => {
    const status = skill.isReady ? '✓' : '⚠ needs setup';
    return `- **${skill.name}** (v${skill.version}) — ${skill.description} [${status}]`;
  });

  return lines.join('\n');
}

/**
 * Remove a skill directory and rebuild CLAUDE.md
 */
export function removeSkill(name: string, root?: string): boolean {
  const skillDir = join(root ? join(root, 'skills') : paths.skills, name);

  if (!existsSync(skillDir)) {
    return false;
  }

  // Remove directory recursively
  rmSync(skillDir, { recursive: true, force: true });

  rebuildClaudeMd(root);
  logger.info(`Removed skill: ${name}`);
  return true;
}
