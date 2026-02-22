/**
 * KyberBot — Skill Registry
 *
 * Tracks installed skills and rebuilds CLAUDE.md when skills change.
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { paths, getAgentName, getHeartbeatInterval } from '../config.js';
import { loadInstalledSkills } from './loader.js';
import { InstalledSkill } from './types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('skills');

/**
 * Rebuild the CLAUDE.md file with current skill information
 */
export function rebuildClaudeMd(): void {
  const templatePath = join(paths.root, '.claude', 'CLAUDE.md');

  if (!existsSync(templatePath)) {
    logger.warn('CLAUDE.md template not found');
    return;
  }

  let content = readFileSync(templatePath, 'utf-8');

  // Replace agent name placeholder
  let agentName: string;
  try {
    agentName = getAgentName();
  } catch {
    agentName = 'KyberBot';
  }
  content = content.replace(/\{\{AGENT_NAME\}\}/g, agentName);

  // Replace heartbeat interval
  try {
    const intervalMs = getHeartbeatInterval();
    const intervalMin = intervalMs / 1000 / 60;
    const intervalStr = intervalMin >= 60 ? `${intervalMin / 60} hour(s)` : `${intervalMin} minutes`;
    content = content.replace(/\{\{HEARTBEAT_INTERVAL\}\}/g, intervalStr);
  } catch {
    content = content.replace(/\{\{HEARTBEAT_INTERVAL\}\}/g, '30 minutes');
  }

  // Insert skill list
  const skills = loadInstalledSkills();
  const skillSection = buildSkillSection(skills);
  content = content.replace(
    /<!-- Auto-populated by skill registry -->/,
    skillSection || '*No skills installed yet. The agent will create them as needed.*'
  );

  writeFileSync(paths.claudeMd, content);
  logger.info(`Rebuilt CLAUDE.md with ${skills.length} skills`);
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
export function removeSkill(name: string): boolean {
  const skillDir = join(paths.skills, name);

  if (!existsSync(skillDir)) {
    return false;
  }

  // Remove directory recursively
  rmSync(skillDir, { recursive: true, force: true });

  rebuildClaudeMd();
  logger.info(`Removed skill: ${name}`);
  return true;
}
