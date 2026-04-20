/**
 * Silent template auto-migration on agent startup.
 *
 * Desktop app users never run `kyberbot update` — they just click "start agent"
 * and expect everything to work. When the CLI version changes (e.g. we add new
 * bus/fleet documentation to the template CLAUDE.md), each agent's local
 * `.claude/CLAUDE.md` and core skill files need to refresh automatically so
 * Claude Code sees the latest instructions on next session.
 *
 * The check is gated on `identity.yaml#kyberbot_version`. If that field is
 * missing or differs from the running CLI's version, we copy template files
 * in, rebuild CLAUDE.md, and stamp the new version. Otherwise we skip — this
 * runs on every agent start, so fast-path matters.
 *
 * Never throws. A migration failure is logged at warn and startup continues
 * with whatever files the agent already has.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { createLogger } from '../logger.js';
import { rebuildClaudeMd } from '../skills/registry.js';

const logger = createLogger('auto-migrate');

const __dirname = dirname(fileURLToPath(import.meta.url));

// Keep in sync with TEMPLATE_FILES in commands/update.ts
const TEMPLATE_FILES: Array<[string, string]> = [
  ['.claude/CLAUDE.md', '.claude/CLAUDE.md'],
  ['.claude/settings.local.json', '.claude/settings.local.json'],
  ['.claude/commands/kyberbot.md', '.claude/commands/kyberbot.md'],
  ['.claude/skills/skill-generator.md', '.claude/skills/skill-generator.md'],
  ['.claude/skills/templates/skill-template.md', '.claude/skills/templates/skill-template.md'],
  ['.claude/agents/templates/agent-template.md', '.claude/agents/templates/agent-template.md'],
  ['.claude/skills/agent-generator.md', '.claude/skills/agent-generator.md'],
  ['skills/recall/SKILL.md', 'skills/recall/SKILL.md'],
  ['skills/remember/SKILL.md', 'skills/remember/SKILL.md'],
  ['skills/brain-note/SKILL.md', 'skills/brain-note/SKILL.md'],
  ['skills/heartbeat-task/SKILL.md', 'skills/heartbeat-task/SKILL.md'],
];

function getCliVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return String(pkg.version || '');
  } catch {
    return '';
  }
}

function resolveTemplateDir(): string | null {
  // __dirname = <monorepo>/packages/cli/dist/templates
  const candidate = join(__dirname, '..', '..', '..', '..', 'template');
  return existsSync(candidate) ? candidate : null;
}

function readIdentity(root: string): Record<string, unknown> | null {
  const identityPath = join(root, 'identity.yaml');
  if (!existsSync(identityPath)) return null;
  try {
    return yaml.load(readFileSync(identityPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeIdentity(root: string, identity: Record<string, unknown>): void {
  const identityPath = join(root, 'identity.yaml');
  writeFileSync(identityPath, yaml.dump(identity, { lineWidth: 120 }));
}

/**
 * Refresh template files silently. Each agent start calls this; it is a
 * no-op when identity.yaml's kyberbot_version matches the running CLI.
 */
export function ensureTemplatesUpToDate(root: string): void {
  try {
    const cliVersion = getCliVersion();
    if (!cliVersion) return; // Can't determine version — skip migration

    const identity = readIdentity(root);
    if (!identity) return; // No identity.yaml — not a real agent root

    const stampedVersion = typeof identity.kyberbot_version === 'string'
      ? identity.kyberbot_version
      : '';

    if (stampedVersion === cliVersion) return; // Up to date — fast path

    const templateDir = resolveTemplateDir();
    if (!templateDir) {
      // Running from a packaged CLI install without the template dir —
      // can happen on some install methods. Not fatal, just skip.
      logger.debug('Template dir not found; skipping auto-migration', { root });
      return;
    }

    logger.info('Auto-refreshing agent templates', {
      root,
      from: stampedVersion || 'unset',
      to: cliVersion,
    });

    // Ensure subdirectories exist (fresh install won't have them)
    for (const subdir of [
      '.claude/commands',
      '.claude/skills/templates',
      '.claude/agents/templates',
      'skills/recall',
      'skills/remember',
      'skills/brain-note',
      'skills/heartbeat-task',
    ]) {
      mkdirSync(join(root, subdir), { recursive: true });
    }

    // Back up the existing CLAUDE.md once so a user who customized it keeps
    // a copy at .bak. We do NOT back up every file — just the most visible one.
    const claudeMdPath = join(root, '.claude', 'CLAUDE.md');
    if (existsSync(claudeMdPath)) {
      try { copyFileSync(claudeMdPath, `${claudeMdPath}.bak`); } catch { /* non-fatal */ }
    }

    let copied = 0;
    for (const [src, dest] of TEMPLATE_FILES) {
      const srcPath = join(templateDir, src);
      const destPath = join(root, dest);
      if (!existsSync(srcPath)) continue;
      try {
        copyFileSync(srcPath, destPath);
        copied++;
      } catch (err) {
        logger.debug('Failed to copy template file', { src, dest, error: String(err) });
      }
    }

    // Substitute placeholders in the files that have them. Skills registry's
    // rebuildClaudeMd handles CLAUDE.md fully; here we only need to fix the
    // commands/kyberbot.md helper which also has {{AGENT_NAME}}.
    try {
      const agentName = typeof identity.agent_name === 'string' ? identity.agent_name : 'KyberBot';
      const kyberbotCmdPath = join(root, '.claude', 'commands', 'kyberbot.md');
      if (existsSync(kyberbotCmdPath)) {
        let content = readFileSync(kyberbotCmdPath, 'utf-8');
        content = content.replace(/\{\{AGENT_NAME\}\}/g, agentName);
        writeFileSync(kyberbotCmdPath, content);
      }
    } catch { /* non-fatal */ }

    // Rebuild CLAUDE.md — fills in agent name, heartbeat interval, skill list,
    // agent list, and strips Kybernesis sections when no API key is set.
    try {
      rebuildClaudeMd(root);
    } catch (err) {
      logger.warn('Failed to rebuild CLAUDE.md after template refresh', {
        root,
        error: String(err),
      });
    }

    // Stamp the version so next startup is a fast no-op
    try {
      identity.kyberbot_version = cliVersion;
      writeIdentity(root, identity);
    } catch (err) {
      logger.warn('Failed to stamp kyberbot_version', { root, error: String(err) });
    }

    logger.info('Agent templates refreshed', { root, copied, version: cliVersion });
  } catch (err) {
    // Never crash startup over a migration failure
    logger.warn('Template auto-migration errored (continuing)', {
      root,
      error: String(err),
    });
  }
}
