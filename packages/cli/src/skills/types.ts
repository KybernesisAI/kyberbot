/**
 * KyberBot — Skill Types
 *
 * Interfaces for the skill manifest (YAML frontmatter in SKILL.md files).
 */

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  requires_env?: string[];
  has_setup?: boolean;
}

export interface InstalledSkill {
  name: string;
  description: string;
  version: string;
  path: string;
  hasSetup: boolean;
  requiresEnv: string[];
  isReady: boolean; // All required env vars are set
}

export interface SkillSearchResult {
  name: string;
  description: string;
  version: string;
  source: string; // 'local' | 'registry'
}
