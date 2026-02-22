/**
 * Skill Command
 *
 * Skill lifecycle management: list, create, remove, setup.
 *
 * Usage:
 *   kyberbot skill list              # Show installed skills
 *   kyberbot skill create <name>     # Scaffold a new skill from template
 *   kyberbot skill remove <name>     # Remove a skill
 *   kyberbot skill setup <name>      # Run setup script for a skill
 *   kyberbot skill info <name>       # Show skill details
 *   kyberbot skill rebuild           # Rebuild CLAUDE.md with current skills
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { getRoot, paths } from '../config.js';
import { loadInstalledSkills, getSkill } from '../skills/loader.js';
import { scaffoldSkill } from '../skills/scaffolder.js';
import { removeSkill, rebuildClaudeMd } from '../skills/registry.js';
import { createLogger } from '../logger.js';

const logger = createLogger('skill-cmd');

export function createSkillCommand(): Command {
  const cmd = new Command('skill')
    .description('Manage agent skills');

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot skill list
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('list')
    .description('Show installed skills')
    .option('--json', 'Output as JSON', false)
    .action((options: { json: boolean }) => {
      const skills = loadInstalledSkills();

      if (options.json) {
        console.log(JSON.stringify(skills, null, 2));
        return;
      }

      console.log(chalk.cyan.bold('\nInstalled Skills\n'));

      if (skills.length === 0) {
        console.log(chalk.dim('  No skills installed yet.'));
        console.log(chalk.dim('  The agent creates skills automatically, or run:'));
        console.log(chalk.dim('  `kyberbot skill create <name>` to scaffold one.\n'));
        return;
      }

      for (const skill of skills) {
        const statusIcon = skill.isReady
          ? chalk.green('[ready]')
          : chalk.yellow('[needs setup]');
        const version = chalk.dim(`v${skill.version}`);

        console.log(`  ${statusIcon} ${chalk.white.bold(skill.name)} ${version}`);
        if (skill.description) {
          console.log(chalk.dim(`           ${skill.description}`));
        }
        if (skill.requiresEnv.length > 0 && !skill.isReady) {
          console.log(chalk.yellow(`           Missing: ${skill.requiresEnv.filter(e => !process.env[e]).join(', ')}`));
        }
      }

      console.log('');
      console.log(chalk.dim(`  ${skills.length} skill(s) installed`));
      console.log('');
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot skill create <name>
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('create')
    .description('Scaffold a new skill from template')
    .argument('<name>', 'Skill name (lowercase, hyphens ok)')
    .option('-d, --description <desc>', 'Skill description', '')
    .option('-e, --env <vars...>', 'Required environment variables')
    .option('-s, --setup', 'Include setup script', false)
    .action((name: string, options: { description: string; env?: string[]; setup: boolean }) => {
      try {
        const skillDir = scaffoldSkill({
          name,
          description: options.description || `${name} skill`,
          requiresEnv: options.env,
          hasSetup: options.setup,
        });

        console.log(chalk.green(`\nSkill scaffolded: ${name}`));
        console.log(chalk.dim(`  Path: ${skillDir}`));
        console.log(chalk.dim('  Edit SKILL.md to define the skill logic.'));
        console.log('');

        // Rebuild CLAUDE.md to include the new skill
        rebuildClaudeMd();
        console.log(chalk.dim('  CLAUDE.md updated with new skill.'));
        console.log('');
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot skill remove <name>
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('remove')
    .description('Remove an installed skill')
    .argument('<name>', 'Skill name')
    .action((name: string) => {
      const removed = removeSkill(name);

      if (removed) {
        console.log(chalk.green(`\nSkill "${name}" removed.`));
        console.log(chalk.dim('  CLAUDE.md updated.\n'));
      } else {
        console.log(chalk.yellow(`\nSkill "${name}" not found.`));
        console.log(chalk.dim('  Run `kyberbot skill list` to see available skills.\n'));
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot skill setup <name>
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('setup')
    .description('Run setup script for a skill')
    .argument('<name>', 'Skill name')
    .action(async (name: string) => {
      const skill = getSkill(name);

      if (!skill) {
        console.error(chalk.red(`Skill not found: ${name}`));
        console.log(chalk.dim('  Run `kyberbot skill list` to see available skills.\n'));
        process.exit(1);
      }

      if (!skill.hasSetup) {
        console.log(chalk.yellow(`Skill "${name}" does not have a setup script.`));
        return;
      }

      // Look for setup.sh or setup.ts in the skill directory
      const setupScripts = ['setup.sh', 'setup.ts', 'setup.js'];
      let setupScript: string | null = null;

      for (const script of setupScripts) {
        const scriptPath = join(skill.path, script);
        if (existsSync(scriptPath)) {
          setupScript = scriptPath;
          break;
        }
      }

      if (!setupScript) {
        console.log(chalk.yellow(`No setup script found in ${skill.path}`));
        console.log(chalk.dim(`Expected one of: ${setupScripts.join(', ')}`));
        return;
      }

      console.log(chalk.cyan(`Running setup for "${name}"...`));
      console.log(chalk.dim(`  Script: ${setupScript}\n`));

      // Execute the setup script
      const ext = setupScript.split('.').pop();
      const command = ext === 'sh' ? 'bash' : 'node';

      return new Promise<void>((resolve, reject) => {
        const proc = spawn(command, [setupScript!], {
          cwd: skill.path,
          stdio: 'inherit',
          env: { ...process.env },
        });

        proc.on('close', (code) => {
          if (code === 0) {
            console.log(chalk.green(`\nSetup completed for "${name}".`));
            resolve();
          } else {
            console.error(chalk.red(`\nSetup failed with exit code ${code}.`));
            reject(new Error(`Setup exited with code ${code}`));
          }
        });

        proc.on('error', (error) => {
          console.error(chalk.red(`Failed to run setup: ${error.message}`));
          reject(error);
        });
      });
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot skill info <name>
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('info')
    .description('Show details about an installed skill')
    .argument('<name>', 'Skill name')
    .action((name: string) => {
      const skill = getSkill(name);

      if (!skill) {
        console.error(chalk.red(`Skill not found: ${name}`));
        console.log(chalk.dim('  Run `kyberbot skill list` to see available skills.\n'));
        process.exit(1);
      }

      const statusIcon = skill.isReady ? chalk.green('[ready]') : chalk.yellow('[needs setup]');

      console.log('');
      console.log(`  ${chalk.cyan.bold(skill.name)} ${chalk.dim(`v${skill.version}`)} ${statusIcon}`);
      console.log(`  ${skill.description}`);
      console.log('');
      console.log(chalk.dim(`  Path:       ${skill.path}`));
      console.log(chalk.dim(`  Has Setup:  ${skill.hasSetup ? 'yes' : 'no'}`));

      if (skill.requiresEnv.length > 0) {
        console.log(chalk.dim(`  Requires:   ${skill.requiresEnv.join(', ')}`));
        const missing = skill.requiresEnv.filter(e => !process.env[e]);
        if (missing.length > 0) {
          console.log(chalk.yellow(`  Missing:    ${missing.join(', ')}`));
        }
      }

      console.log('');
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot skill rebuild
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('rebuild')
    .description('Rebuild CLAUDE.md with current skills')
    .action(() => {
      try {
        rebuildClaudeMd();
        console.log(chalk.green('\nCLAUDE.md rebuilt with current skills.\n'));
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  return cmd;
}
