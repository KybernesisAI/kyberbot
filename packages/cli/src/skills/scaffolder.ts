/**
 * KyberBot — Skill Scaffolder
 *
 * Generates new skill directories from the template.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { paths } from '../config.js';
import { createLogger } from '../logger.js';

const logger = createLogger('skills');

export interface ScaffoldOptions {
  name: string;
  description: string;
  requiresEnv?: string[];
  hasSetup?: boolean;
}

/**
 * Create a new skill from template
 */
export function scaffoldSkill(options: ScaffoldOptions): string {
  const skillDir = join(paths.skills, options.name);

  if (existsSync(skillDir)) {
    throw new Error(`Skill already exists: ${options.name}`);
  }

  mkdirSync(skillDir, { recursive: true });

  // Read template
  const templatePath = join(paths.root, '.claude', 'skills', 'templates', 'skill-template.md');
  let template: string;

  if (existsSync(templatePath)) {
    template = readFileSync(templatePath, 'utf-8');
  } else {
    template = getDefaultTemplate();
  }

  // Fill in template
  const content = template
    .replace(/\[skill-name\]/g, options.name)
    .replace(/\[Skill Name\]/g, formatSkillName(options.name))
    .replace(/\[One-line description.*?\]/g, options.description)
    .replace(
      /requires_env:\n  - \[ENV_VAR_NAME\]/g,
      options.requiresEnv && options.requiresEnv.length > 0
        ? `requires_env:\n${options.requiresEnv.map(e => `  - ${e}`).join('\n')}`
        : 'requires_env: []'
    )
    .replace(/has_setup: false/g, `has_setup: ${options.hasSetup ? 'true' : 'false'}`);

  const manifestPath = join(skillDir, 'SKILL.md');
  writeFileSync(manifestPath, content);

  logger.info(`Scaffolded skill: ${options.name}`, { path: skillDir });
  return skillDir;
}

function formatSkillName(name: string): string {
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getDefaultTemplate(): string {
  return `---
name: [skill-name]
description: [One-line description]
version: 1.0.0
requires_env: []
has_setup: false
---

# [Skill Name]

## What This Does

[Description]

## How to Use

- "[trigger phrase]"

## Implementation

[Instructions]
`;
}
