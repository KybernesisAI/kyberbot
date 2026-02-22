/**
 * KyberBot — Skill Loader
 *
 * Discovers and loads installed skills from the skills/ directory.
 * Skills are directories containing a SKILL.md file with YAML frontmatter.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { paths } from '../config.js';
import { InstalledSkill, SkillManifest } from './types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('skills');

/**
 * Discover all installed skills
 */
export function loadInstalledSkills(): InstalledSkill[] {
  const skillsDir = paths.skills;

  if (!existsSync(skillsDir)) {
    return [];
  }

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  const skills: InstalledSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = join(skillsDir, entry.name);
    const manifestPath = join(skillDir, 'SKILL.md');

    if (!existsSync(manifestPath)) continue;

    try {
      const content = readFileSync(manifestPath, 'utf-8');
      const manifest = parseSkillManifest(content);

      if (!manifest) {
        logger.warn(`Invalid skill manifest: ${entry.name}`);
        continue;
      }

      const requiresEnv = manifest.requires_env || [];
      const isReady = requiresEnv.every(env => !!process.env[env]);

      skills.push({
        name: manifest.name || entry.name,
        description: manifest.description || '',
        version: manifest.version || '0.0.0',
        path: skillDir,
        hasSetup: manifest.has_setup || false,
        requiresEnv,
        isReady,
      });
    } catch (error) {
      logger.warn(`Failed to load skill: ${entry.name}`, { error: String(error) });
    }
  }

  return skills;
}

/**
 * Parse YAML frontmatter from a SKILL.md file
 */
function parseSkillManifest(content: string): SkillManifest | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  try {
    return yaml.load(match[1]) as SkillManifest;
  } catch {
    return null;
  }
}

/**
 * Get a specific skill by name
 */
export function getSkill(name: string): InstalledSkill | null {
  const skills = loadInstalledSkills();
  return skills.find(s => s.name === name) || null;
}

/**
 * Check if a skill exists
 */
export function hasSkill(name: string): boolean {
  return getSkill(name) !== null;
}
