/**
 * Backup Command
 *
 * Manage GitHub backups of agent data — SQLite databases, Claude Code memory,
 * identity, skills, brain notes, and configuration.
 *
 * Usage:
 *   kyberbot backup setup    # Interactive backup configuration
 *   kyberbot backup run      # Checkpoint DBs, sync memory, commit & push
 *   kyberbot backup verify   # Verify backup integrity
 *   kyberbot backup status   # Show backup config and last commit
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { paths, getRoot, getBackupConfig, getAgentName, getClaudeMemorySourcePath } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function git(...args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: getRoot(), stdio: 'pipe', encoding: 'utf-8' });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function hasGit(): boolean {
  const result = spawnSync('git', ['--version'], { stdio: 'pipe' });
  return result.status === 0;
}

function hasSqlite3(): boolean {
  const result = spawnSync('sqlite3', ['--version'], { stdio: 'pipe' });
  return result.status === 0;
}

function isGitRepo(): boolean {
  return git('rev-parse', '--is-inside-work-tree').ok;
}

function checkpointDb(dbPath: string): { ok: boolean; name: string } {
  const name = dbPath.split('/').pop() || dbPath;
  if (!existsSync(dbPath)) return { ok: true, name }; // skip missing DBs gracefully
  const result = spawnSync('sqlite3', [dbPath, 'PRAGMA wal_checkpoint(TRUNCATE);'], {
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  return { ok: result.status === 0, name };
}

function getTemplateDir(): string {
  return join(__dirname, '..', '..', '..', '..', 'template');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Subcommands
// ═══════════════════════════════════════════════════════════════════════════════

export function createBackupCommand(): Command {
  const cmd = new Command('backup')
    .description('Manage GitHub backup of agent data');

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot backup setup
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('setup')
    .description('Interactive backup configuration')
    .action(async () => {
      const { input, confirm } = await import('@inquirer/prompts');
      const root = getRoot();

      console.log(chalk.bold('\nGitHub Backup Setup\n'));
      console.log(chalk.dim('  Back up your agent\'s memory, skills, and identity to a private GitHub repo.'));
      console.log(chalk.dim('  Requires: git, SSH key with GitHub access, a private GitHub repo.\n'));

      // Check prerequisites
      if (!hasGit()) {
        console.log(chalk.red('  git is not installed. Install it first: https://git-scm.com'));
        return;
      }

      // Collect repo URL
      const remoteUrl = await input({
        message: 'GitHub repo URL (SSH):',
        validate: (v: string) => {
          if (!v.trim()) return 'Repository URL is required';
          if (!v.includes('git@') && !v.includes('https://')) return 'Use SSH (git@github.com:...) or HTTPS URL';
          return true;
        },
      });

      // Validate SSH access
      console.log(chalk.dim('\n  Validating access...'));
      const lsRemote = spawnSync('git', ['ls-remote', remoteUrl.trim()], {
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 15000,
      });

      if (lsRemote.status !== 0) {
        console.log(chalk.yellow('  Could not reach the repository.'));
        console.log(chalk.dim(`  Error: ${(lsRemote.stderr || '').trim()}`));
        const proceed = await confirm({
          message: 'Continue anyway? (you can fix SSH access later)',
          default: false,
        });
        if (!proceed) return;
      } else {
        console.log(chalk.green('  Repository accessible.'));
      }

      // Schedule
      const schedule = await input({
        message: 'Backup schedule (duration string):',
        default: '4h',
      });

      // Branch
      const branch = await input({
        message: 'Branch name:',
        default: 'main',
      });

      // Initialize git if needed
      if (!isGitRepo()) {
        console.log(chalk.dim('\n  Initializing git repository...'));
        git('init');
        git('remote', 'add', 'origin', remoteUrl.trim());
        console.log(chalk.green('  Git initialized with remote.'));
      } else {
        // Check if remote already exists
        const currentRemote = git('remote', 'get-url', 'origin');
        if (!currentRemote.ok) {
          git('remote', 'add', 'origin', remoteUrl.trim());
        } else if (currentRemote.stdout !== remoteUrl.trim()) {
          git('remote', 'set-url', 'origin', remoteUrl.trim());
          console.log(chalk.dim('  Updated remote URL.'));
        }
      }

      // Write .gitignore for backup mode
      writeBackupGitignore(root);

      // Create data/claude-memory/ and scripts/ directories
      mkdirSync(join(root, 'data', 'claude-memory'), { recursive: true });
      mkdirSync(join(root, 'scripts'), { recursive: true });

      // Install backup skill template
      const templateDir = getTemplateDir();
      const skillSrc = join(templateDir, 'skills', 'backup', 'SKILL.md');
      const skillDest = join(root, 'skills', 'backup', 'SKILL.md');
      if (existsSync(skillSrc)) {
        mkdirSync(join(root, 'skills', 'backup'), { recursive: true });
        copyFileSync(skillSrc, skillDest);
        console.log(chalk.green('  + skills/backup/SKILL.md'));
      }

      // Install verify script template
      const verifySrc = join(templateDir, 'scripts', 'verify-backup.sh');
      const verifyDest = join(root, 'scripts', 'verify-backup.sh');
      if (existsSync(verifySrc)) {
        copyFileSync(verifySrc, verifyDest);
        chmodSync(verifyDest, 0o755);
        console.log(chalk.green('  + scripts/verify-backup.sh'));
      }

      // Update identity.yaml
      const identityPath = paths.identity;
      const currentIdentity = yaml.load(readFileSync(identityPath, 'utf-8')) as Record<string, unknown>;
      currentIdentity.backup = {
        enabled: true,
        remote_url: remoteUrl.trim(),
        schedule,
        branch,
      };
      writeFileSync(identityPath, yaml.dump(currentIdentity, { lineWidth: 120 }));
      console.log(chalk.green('  Updated identity.yaml with backup config.'));

      // Inject heartbeat task
      injectHeartbeatTask(root, schedule);

      // Rebuild CLAUDE.md to include backup skill
      try {
        const { rebuildClaudeMd } = await import('../skills/registry.js');
        await rebuildClaudeMd();
        console.log(chalk.green('  Rebuilt CLAUDE.md with backup skill.'));
      } catch {
        console.log(chalk.dim('  Note: run `kyberbot skill rebuild` to update CLAUDE.md.'));
      }

      console.log(chalk.green('\n  Backup configured successfully.'));
      console.log(chalk.dim('  Run `kyberbot backup run` to create the first backup.'));
      console.log(chalk.dim('  Automated backups will run every ' + schedule + ' via heartbeat.\n'));
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot backup run
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('run')
    .description('Checkpoint databases, sync memory, commit & push to GitHub')
    .action(async () => {
      const root = getRoot();
      const config = getBackupConfig();
      const agentName = getAgentName();

      if (!config) {
        console.log(chalk.yellow('Backup is not configured. Run `kyberbot backup setup` first.'));
        return;
      }

      if (!isGitRepo()) {
        console.log(chalk.yellow('Git repository not initialized. Running git init...'));
        git('init');
        if (config.remote_url) {
          git('remote', 'add', 'origin', config.remote_url);
        }
      }

      console.log(chalk.bold(`\nBacking up ${agentName}...\n`));

      // Step 1: Checkpoint SQLite WAL files
      console.log(chalk.dim('1. Checkpointing SQLite databases...'));
      const dbs = [paths.entityDb, paths.timelineDb, paths.sleepDb, paths.messagesDb];
      let checkpointOk = true;

      if (hasSqlite3()) {
        for (const db of dbs) {
          const result = checkpointDb(db);
          if (!existsSync(db)) {
            console.log(chalk.dim(`   ${result.name} — skipped (not created yet)`));
          } else if (result.ok) {
            console.log(chalk.green(`   ${result.name} — checkpointed`));
          } else {
            console.log(chalk.yellow(`   ${result.name} — checkpoint failed (may be locked)`));
            checkpointOk = false;
          }
        }
      } else {
        console.log(chalk.yellow('   sqlite3 not found — skipping WAL checkpoint'));
        console.log(chalk.dim('   Install sqlite3 for complete backups'));
        checkpointOk = false;
      }

      // Step 2: Sync Claude Code memory
      console.log(chalk.dim('\n2. Syncing Claude Code memory...'));
      const memorySource = getClaudeMemorySourcePath();
      const memoryDest = paths.claudeMemory;
      mkdirSync(memoryDest, { recursive: true });

      if (existsSync(memorySource)) {
        try {
          const files = readdirSync(memorySource).filter(f => f.endsWith('.md'));
          for (const file of files) {
            copyFileSync(join(memorySource, file), join(memoryDest, file));
          }
          console.log(chalk.green(`   Synced ${files.length} memory file(s)`));
        } catch (err) {
          console.log(chalk.yellow(`   Could not sync memory: ${err}`));
        }
      } else {
        console.log(chalk.dim('   No Claude Code memory directory found — skipping'));
      }

      // Step 3: Git commit and push
      console.log(chalk.dim('\n3. Committing and pushing...'));

      // Check for changes
      const status = git('status', '--porcelain');
      if (!status.stdout) {
        console.log(chalk.dim('   No changes to commit.'));
        console.log(chalk.green('\nBackup complete — already up to date.\n'));
        return;
      }

      git('add', '-A');
      const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
      const commitResult = git('commit', '-m', `backup: ${agentName} state ${now}`);
      if (commitResult.ok) {
        console.log(chalk.green(`   Committed: backup: ${agentName} state ${now}`));
      } else {
        console.log(chalk.yellow(`   Commit failed: ${commitResult.stderr}`));
        return;
      }

      // Push
      const pushResult = git('push', 'origin', config.branch);
      if (pushResult.ok) {
        console.log(chalk.green(`   Pushed to origin/${config.branch}`));
      } else {
        // First push may need -u
        const pushU = git('push', '-u', 'origin', config.branch);
        if (pushU.ok) {
          console.log(chalk.green(`   Pushed to origin/${config.branch} (set upstream)`));
        } else {
          console.log(chalk.yellow(`   Push failed: ${pushU.stderr}`));
          console.log(chalk.dim('   Changes are committed locally. Push manually when ready.'));
        }
      }

      console.log(chalk.green(`\nBackup complete.${!checkpointOk ? ' (with warnings)' : ''}\n`));
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot backup verify
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('verify')
    .description('Verify backup integrity (SQLite, files, git state)')
    .action(async () => {
      const root = getRoot();
      let passed = 0;
      let failed = 0;
      let warnings = 0;

      const pass = (msg: string) => { console.log(chalk.green(`  + ${msg}`)); passed++; };
      const fail = (msg: string) => { console.log(chalk.red(`  x ${msg}`)); failed++; };
      const warn = (msg: string) => { console.log(chalk.yellow(`  ! ${msg}`)); warnings++; };

      console.log(chalk.bold('\n=== Backup Verification ===\n'));

      // 1. SQLite databases
      console.log(chalk.dim('1. SQLite databases'));
      const dbNames = ['entity-graph', 'timeline', 'sleep', 'messages'];
      for (const name of dbNames) {
        const dbPath = join(root, 'data', `${name}.db`);
        if (!existsSync(dbPath)) {
          warn(`${name}.db — not created yet`);
          continue;
        }

        if (hasSqlite3()) {
          const integrity = spawnSync('sqlite3', [dbPath, 'PRAGMA integrity_check;'], {
            stdio: 'pipe',
            encoding: 'utf-8',
          });
          if (integrity.stdout?.trim() === 'ok') {
            pass(`${name}.db — integrity OK`);
          } else {
            fail(`${name}.db — integrity FAILED`);
          }

          // Check WAL size
          const walPath = `${dbPath}-wal`;
          if (existsSync(walPath)) {
            const walSize = statSync(walPath).size;
            if (walSize > 1048576) {
              warn(`${name}.db — WAL is ${walSize} bytes (>1MB). Run checkpoint.`);
            }
          }
        } else {
          warn(`${name}.db — sqlite3 not installed, cannot verify`);
        }
      }

      console.log();

      // 2. ChromaDB
      console.log(chalk.dim('2. ChromaDB vector store'));
      const chromaDir = join(root, 'data', 'chromadb');
      if (existsSync(chromaDir)) {
        try {
          const files = readdirSync(chromaDir, { recursive: true });
          if (files.length > 0) {
            pass(`ChromaDB — ${files.length} files`);
          } else {
            warn('ChromaDB — directory exists but is empty');
          }
        } catch {
          warn('ChromaDB — could not read directory');
        }
      } else {
        warn('ChromaDB — data/chromadb/ not found (created on first run)');
      }

      console.log();

      // 3. Claude Code memory
      console.log(chalk.dim('3. Claude Code memory'));
      const memoryDir = paths.claudeMemory;
      if (existsSync(memoryDir)) {
        const mdFiles = readdirSync(memoryDir).filter(f => f.endsWith('.md'));
        if (mdFiles.length > 0) {
          pass(`Claude memory — ${mdFiles.length} files synced`);
          if (mdFiles.includes('MEMORY.md')) {
            pass('MEMORY.md index present');
          } else {
            warn('MEMORY.md index missing');
          }
        } else {
          warn('Claude memory — directory exists but no .md files');
        }
      } else {
        warn('Claude memory — data/claude-memory/ not synced yet');
      }

      console.log();

      // 4. Identity & config files
      console.log(chalk.dim('4. Identity & configuration'));
      for (const f of ['SOUL.md', 'USER.md', 'HEARTBEAT.md', 'identity.yaml']) {
        if (existsSync(join(root, f))) {
          pass(`${f} present`);
        } else {
          fail(`${f} missing`);
        }
      }

      console.log();

      // 5. Skills
      console.log(chalk.dim('5. Skills'));
      const skillsDir = join(root, 'skills');
      if (existsSync(skillsDir)) {
        const skillCount = readdirSync(skillsDir).filter(d => {
          return existsSync(join(skillsDir, d, 'SKILL.md'));
        }).length;
        pass(`${skillCount} skills installed`);
      } else {
        fail('skills/ directory missing');
      }

      console.log();

      // 6. Brain notes
      console.log(chalk.dim('6. Brain notes'));
      const brainDir = join(root, 'brain');
      if (existsSync(brainDir)) {
        const notes = readdirSync(brainDir).filter(f => f.endsWith('.md'));
        pass(`${notes.length} brain notes`);
      } else {
        warn('brain/ directory missing');
      }

      console.log();

      // 7. Git state
      console.log(chalk.dim('7. Git state'));
      if (isGitRepo()) {
        pass('Git repository valid');

        const lastCommit = git('log', '--oneline', '-1');
        if (lastCommit.ok && lastCommit.stdout) {
          pass(`Last commit: ${lastCommit.stdout}`);
        } else {
          warn('No commits yet');
        }

        const remoteUrl = git('remote', 'get-url', 'origin');
        if (remoteUrl.ok) {
          pass(`Remote: ${remoteUrl.stdout}`);
        } else {
          fail('No remote configured');
        }

        // Check sync status
        const fetchResult = git('fetch', 'origin', '--quiet');
        if (fetchResult.ok) {
          const config = getBackupConfig();
          const branch = config?.branch || 'main';
          const ahead = git('rev-list', '--count', `origin/${branch}..HEAD`);
          if (ahead.ok) {
            const count = parseInt(ahead.stdout, 10);
            if (count > 0) {
              warn(`Local is ${count} commit(s) ahead of remote — push needed`);
            } else {
              pass('In sync with remote');
            }
          }
        }
      } else {
        fail('Not a git repository');
      }

      // Summary
      console.log(chalk.bold('\n=== Results ==='));
      console.log(`  Passed:   ${passed}`);
      console.log(`  Failed:   ${failed}`);
      console.log(`  Warnings: ${warnings}`);
      console.log();

      if (failed > 0) {
        console.log(chalk.red(`VERIFICATION FAILED — ${failed} issue(s) need attention\n`));
        process.exitCode = 1;
      } else if (warnings > 0) {
        console.log(chalk.yellow(`BACKUP OK with ${warnings} warning(s)\n`));
      } else {
        console.log(chalk.green('BACKUP VERIFIED — all checks passed\n'));
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot backup status
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('status')
    .description('Show backup configuration and last commit')
    .action(async () => {
      const config = getBackupConfig();

      console.log(chalk.bold('\nBackup Status\n'));

      if (!config) {
        console.log(chalk.yellow('  Backup is not configured.'));
        console.log(chalk.dim('  Run `kyberbot backup setup` to enable GitHub backup.\n'));
        return;
      }

      console.log(`  Enabled:    ${chalk.green('yes')}`);
      console.log(`  Remote:     ${config.remote_url}`);
      console.log(`  Branch:     ${config.branch}`);
      console.log(`  Schedule:   every ${config.schedule}`);

      if (isGitRepo()) {
        const lastCommit = git('log', '--format=%h %s (%cr)', '-1');
        if (lastCommit.ok && lastCommit.stdout) {
          console.log(`  Last backup: ${lastCommit.stdout}`);
        } else {
          console.log(`  Last backup: ${chalk.dim('no commits yet')}`);
        }

        // Sync status
        const fetchResult = git('fetch', 'origin', '--quiet');
        if (fetchResult.ok) {
          const ahead = git('rev-list', '--count', `origin/${config.branch}..HEAD`);
          const behind = git('rev-list', '--count', `HEAD..origin/${config.branch}`);
          if (ahead.ok && behind.ok) {
            const a = parseInt(ahead.stdout, 10);
            const b = parseInt(behind.stdout, 10);
            if (a === 0 && b === 0) {
              console.log(`  Sync:       ${chalk.green('up to date')}`);
            } else {
              if (a > 0) console.log(`  Sync:       ${chalk.yellow(`${a} commit(s) ahead`)}`);
              if (b > 0) console.log(`  Sync:       ${chalk.yellow(`${b} commit(s) behind`)}`);
            }
          }
        }
      } else {
        console.log(`  Git:        ${chalk.yellow('not initialized')}`);
      }

      console.log();
    });

  return cmd;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared utilities (also used by onboard.ts)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Write a .gitignore suitable for backup mode.
 * Tracks data/*.db but ignores WAL/SHM files and .env.
 */
export function writeBackupGitignore(root: string): void {
  const content = [
    'node_modules/',
    '.env',
    'heartbeat-state.json',
    'logs/',
    '*.log',
    '*.bak',
    '.DS_Store',
    '.claude/settings.local.json',
    '',
    '# SQLite WAL/SHM files (regenerated at runtime)',
    'data/*.db-wal',
    'data/*.db-shm',
    '',
  ].join('\n');

  writeFileSync(join(root, '.gitignore'), content);
}

/**
 * Inject the backup heartbeat task into HEARTBEAT.md if not already present.
 */
export function injectHeartbeatTask(root: string, schedule: string): void {
  const heartbeatPath = join(root, 'HEARTBEAT.md');
  if (!existsSync(heartbeatPath)) return;

  let content = readFileSync(heartbeatPath, 'utf-8');
  if (content.includes('Backup to GitHub')) return; // already present

  const task = [
    '',
    '### Backup to GitHub',
    `**Schedule**: every ${schedule}`,
    '**Action**: Run `kyberbot backup run` to checkpoint databases, sync Claude Code memory, and push to GitHub. Only commit if there are actual changes.',
    '**Skill**: backup',
    '',
  ].join('\n');

  // Insert before the trailing --- separator if present, otherwise append
  const separatorIdx = content.lastIndexOf('\n---\n');
  if (separatorIdx !== -1) {
    content = content.slice(0, separatorIdx) + task + content.slice(separatorIdx);
  } else {
    content = content.trimEnd() + '\n' + task;
  }

  writeFileSync(heartbeatPath, content);
  console.log(chalk.green('  + HEARTBEAT.md — added backup task'));
}
