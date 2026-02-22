/**
 * Update Command
 *
 * Updates the KyberBot CLI source and refreshes template files in agent instances.
 *
 * Usage:
 *   kyberbot update              # Full update: CLI source + agent templates
 *   kyberbot update --check      # Show what would change, don't do anything
 *   kyberbot update --templates  # Only refresh agent template files (skip CLI update)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { getRoot, getAgentName, getHeartbeatInterval } from '../config.js';
import { rebuildClaudeMd } from '../skills/registry.js';
import { IdentityConfig } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EMERALD = chalk.hex('#50C878');

// Template files to copy from template/.claude/ into agent .claude/
const TEMPLATE_FILES = [
  ['.claude/CLAUDE.md', '.claude/CLAUDE.md'],
  ['.claude/settings.local.json', '.claude/settings.local.json'],
  ['.claude/commands/kyberbot.md', '.claude/commands/kyberbot.md'],
  ['.claude/skills/skill-generator.md', '.claude/skills/skill-generator.md'],
  ['.claude/skills/templates/skill-template.md', '.claude/skills/templates/skill-template.md'],
];

/**
 * Resolve the KyberBot monorepo root from __dirname.
 *
 * When installed via `npm link`, __dirname points to the actual source at
 * <monorepo>/packages/cli/dist/commands/. Walk 4 levels up to reach the root.
 */
function resolveSourceRepo(): string | null {
  // __dirname = <monorepo>/packages/cli/dist/commands
  const candidate = join(__dirname, '..', '..', '..', '..');

  // Validate: must have .git and packages/cli/src
  if (
    existsSync(join(candidate, '.git')) &&
    existsSync(join(candidate, 'packages', 'cli', 'src'))
  ) {
    return candidate;
  }

  return null;
}

/**
 * Get the template directory path from the source repo.
 */
function resolveTemplateDir(): string {
  return join(__dirname, '..', '..', '..', '..', 'template');
}

/**
 * Read the CLI version from the monorepo root package.json.
 */
function getCliVersion(repoPath: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, 'packages', 'cli', 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

interface UpdateCheckResult {
  hasUpdates: boolean;
  commits: string[];
  currentVersion: string;
}

/**
 * Fetch from origin and check if there are new commits on main.
 */
function checkForUpdates(repoPath: string): UpdateCheckResult {
  const currentVersion = getCliVersion(repoPath);

  try {
    execFileSync('git', ['fetch', 'origin'], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.log(chalk.yellow('  Warning: Could not fetch from origin. Checking local state only.'));
  }

  let commits: string[] = [];
  try {
    const output = execFileSync('git', ['log', 'HEAD..origin/main', '--oneline'], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    commits = output.trim().split('\n').filter(Boolean);
  } catch {
    // No origin/main or other git error -- treat as no updates
  }

  return {
    hasUpdates: commits.length > 0,
    commits,
    currentVersion,
  };
}

/**
 * Pull latest changes and rebuild the CLI.
 */
function pullAndBuild(repoPath: string): void {
  console.log(chalk.dim('  Pulling latest changes...'));
  execFileSync('git', ['pull', 'origin', 'main'], {
    cwd: repoPath,
    stdio: 'inherit',
  });

  console.log(chalk.dim('\n  Installing dependencies...'));
  execFileSync('npm', ['install'], {
    cwd: repoPath,
    stdio: 'inherit',
  });

  console.log(chalk.dim('\n  Building...'));
  execFileSync('npm', ['run', 'build'], {
    cwd: repoPath,
    stdio: 'inherit',
  });
}

/**
 * Refresh template files in the current agent instance.
 */
function refreshTemplates(root: string): string[] {
  const templateDir = resolveTemplateDir();
  const refreshed: string[] = [];

  if (!existsSync(templateDir)) {
    console.log(chalk.yellow('  Template directory not found. Skipping template refresh.'));
    return refreshed;
  }

  // Ensure .claude/ subdirectories exist
  mkdirSync(join(root, '.claude', 'commands'), { recursive: true });
  mkdirSync(join(root, '.claude', 'skills', 'templates'), { recursive: true });
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });

  // Back up CLAUDE.md before overwriting
  const claudeMdPath = join(root, '.claude', 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    copyFileSync(claudeMdPath, `${claudeMdPath}.bak`);
    console.log(chalk.dim('  Backed up .claude/CLAUDE.md -> .claude/CLAUDE.md.bak'));
  }

  // Copy template files
  for (const [src, dest] of TEMPLATE_FILES) {
    const srcPath = join(templateDir, src);
    const destPath = join(root, dest);
    if (existsSync(srcPath)) {
      copyFileSync(srcPath, destPath);
      refreshed.push(dest);
    }
  }

  // Replace placeholders
  let agentName: string;
  try {
    agentName = getAgentName();
  } catch {
    agentName = 'KyberBot';
  }

  let intervalStr = '30 minutes';
  try {
    const intervalMs = getHeartbeatInterval();
    const intervalMin = intervalMs / 1000 / 60;
    intervalStr = intervalMin >= 60 ? `${intervalMin / 60} hour(s)` : `${intervalMin} minutes`;
  } catch {
    // use default
  }

  const placeholderFiles = [
    join(root, '.claude', 'CLAUDE.md'),
    join(root, '.claude', 'commands', 'kyberbot.md'),
  ];
  for (const filePath of placeholderFiles) {
    if (existsSync(filePath)) {
      let content = readFileSync(filePath, 'utf-8');
      content = content.replace(/\{\{AGENT_NAME\}\}/g, agentName);
      content = content.replace(/\{\{HEARTBEAT_INTERVAL\}\}/g, intervalStr);
      writeFileSync(filePath, content);
    }
  }

  // Rebuild skill registry into CLAUDE.md
  try {
    rebuildClaudeMd();
  } catch {
    // Non-fatal -- skill registry may not be initialized yet
  }

  // Copy docker-compose.yml
  const dockerComposeSrc = join(templateDir, 'docker-compose.yml');
  if (existsSync(dockerComposeSrc)) {
    copyFileSync(dockerComposeSrc, join(root, 'docker-compose.yml'));
    refreshed.push('docker-compose.yml');
  }

  return refreshed;
}

/**
 * Write/update the kyberbot_version field in identity.yaml.
 */
function stampVersion(root: string, version: string): void {
  const identityPath = join(root, 'identity.yaml');
  if (!existsSync(identityPath)) return;

  const raw = readFileSync(identityPath, 'utf-8');
  const identity = yaml.load(raw) as Record<string, unknown>;
  identity.kyberbot_version = version;
  writeFileSync(identityPath, yaml.dump(identity, { lineWidth: 120 }));
}

export function createUpdateCommand(): Command {
  return new Command('update')
    .description('Update KyberBot CLI and refresh agent template files')
    .option('--check', 'Show what would change without making changes')
    .option('--templates', 'Only refresh template files (skip CLI source update)')
    .action(async (options: { check?: boolean; templates?: boolean }) => {
      console.log();

      const repoPath = resolveSourceRepo();

      // ─────────────────────────────────────────────────────────────────
      // --check mode
      // ─────────────────────────────────────────────────────────────────

      if (options.check) {
        console.log(chalk.bold('Update Check\n'));

        if (!repoPath) {
          console.log(chalk.yellow('  Could not find KyberBot source repository.'));
          console.log(chalk.dim('  Update manually: cd /path/to/kyberbot && git pull && npm run build\n'));
        } else {
          const { hasUpdates, commits, currentVersion } = checkForUpdates(repoPath);
          console.log(chalk.dim(`  CLI version:  ${currentVersion}`));
          console.log(chalk.dim(`  Source repo:  ${repoPath}`));

          if (hasUpdates) {
            console.log(EMERALD(`\n  ${commits.length} update(s) available:\n`));
            for (const commit of commits) {
              console.log(`    ${commit}`);
            }
          } else {
            console.log(chalk.green('\n  CLI source is up to date.'));
          }
        }

        // Check agent instance
        let root: string | null = null;
        try {
          root = getRoot();
        } catch {
          // Not in an agent directory
        }

        if (root) {
          const identityPath = join(root, 'identity.yaml');
          let currentAgentVersion = 'not set';
          if (existsSync(identityPath)) {
            const identity = yaml.load(readFileSync(identityPath, 'utf-8')) as Record<string, unknown>;
            if (identity.kyberbot_version) {
              currentAgentVersion = String(identity.kyberbot_version);
            }
          }

          console.log(chalk.dim(`\n  Agent root:   ${root}`));
          console.log(chalk.dim(`  Agent version: ${currentAgentVersion}`));
          console.log(chalk.dim('\n  Template files that would be refreshed:'));
          for (const [, dest] of TEMPLATE_FILES) {
            console.log(chalk.dim(`    ${dest}`));
          }
          console.log(chalk.dim('    docker-compose.yml'));
        } else {
          console.log(chalk.dim('\n  Not in an agent directory. Template refresh would be skipped.'));
        }

        console.log('');
        return;
      }

      // ─────────────────────────────────────────────────────────────────
      // CLI source update (unless --templates)
      // ─────────────────────────────────────────────────────────────────

      let newVersion: string | null = null;

      if (!options.templates) {
        console.log(chalk.bold('Step 1: Update CLI Source\n'));

        if (!repoPath) {
          console.log(chalk.yellow('  Could not find KyberBot source repository.'));
          console.log(chalk.dim('  Update manually: cd /path/to/kyberbot && git pull && npm run build'));
          console.log(chalk.dim('  Then run `kyberbot update --templates` from your agent folder.\n'));
          return;
        }

        const { hasUpdates, commits, currentVersion } = checkForUpdates(repoPath);

        if (hasUpdates) {
          console.log(EMERALD(`  ${commits.length} new commit(s):\n`));
          for (const commit of commits) {
            console.log(`    ${commit}`);
          }
          console.log('');

          try {
            pullAndBuild(repoPath);
            newVersion = getCliVersion(repoPath);
            console.log(EMERALD(`\n  CLI updated: ${currentVersion} -> ${newVersion}\n`));
          } catch (err) {
            console.error(chalk.red(`\n  Update failed: ${err}`));
            console.log(chalk.dim('  Resolve the issue manually, then run `kyberbot update --templates`.\n'));
            return;
          }
        } else {
          newVersion = currentVersion;
          console.log(chalk.green(`  Already on the latest version (${currentVersion}).`));
          console.log('');
        }
      } else {
        // --templates mode: just get current version for stamping
        if (repoPath) {
          newVersion = getCliVersion(repoPath);
        }
      }

      // ─────────────────────────────────────────────────────────────────
      // Template refresh
      // ─────────────────────────────────────────────────────────────────

      let root: string | null = null;
      try {
        root = getRoot();
      } catch {
        // Not in an agent directory
      }

      if (!root) {
        if (!options.templates) {
          console.log(chalk.dim('  CLI source updated. Run `kyberbot update` from an agent folder to refresh templates.\n'));
        } else {
          console.log(chalk.yellow('  Not in an agent directory. Nothing to refresh.\n'));
        }
        return;
      }

      const stepLabel = options.templates ? 'Refresh Templates' : 'Step 2: Refresh Templates';
      console.log(chalk.bold(`${stepLabel}\n`));

      const refreshed = refreshTemplates(root);

      if (refreshed.length > 0) {
        console.log(EMERALD(`\n  Refreshed ${refreshed.length} file(s):`));
        for (const file of refreshed) {
          console.log(chalk.green(`    + ${file}`));
        }
      } else {
        console.log(chalk.dim('  No template files were refreshed.'));
      }

      // ─────────────────────────────────────────────────────────────────
      // Stamp version
      // ─────────────────────────────────────────────────────────────────

      if (newVersion) {
        stampVersion(root, newVersion);
        console.log(chalk.dim(`\n  Stamped kyberbot_version: ${newVersion} in identity.yaml`));
      }

      // ─────────────────────────────────────────────────────────────────
      // Summary
      // ─────────────────────────────────────────────────────────────────

      console.log();
      console.log(chalk.bold('  Preserved (untouched):'));
      console.log(chalk.dim('    SOUL.md, USER.md, HEARTBEAT.md'));
      console.log(chalk.dim('    brain/, skills/, data/, logs/'));
      console.log(chalk.dim('    .env, heartbeat-state.json'));
      console.log();
      console.log(EMERALD.bold('  Update complete.'));
      console.log('');
    });
}
