/**
 * Onboard Command
 *
 * Interactive setup wizard with 9 steps:
 *   Step 1: Agent identity (name, description, SOUL.md choice)
 *   Step 2: User identity (name, timezone, location, about)
 *   Step 3: Claude Code mode (subscription vs SDK)
 *   Step 4: Brain & heartbeat init (mkdir data/, init memory DBs)
 *   Step 5: Kybernesis (optional cloud sync)
 *   Step 6: Remote Access (optional ngrok tunnel)
 *   Step 7: Channels (Telegram/WhatsApp - optional)
 *   Step 8: GitHub Backup (optional)
 *   Step 9: Done - show summary
 *
 * Usage:
 *   kyberbot onboard
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
import yaml from 'js-yaml';
import { input, select, confirm } from '@inquirer/prompts';

import { displayBanner } from '../splash.js';
import { writeBackupGitignore, injectHeartbeatTask } from './backup.js';

const EMERALD = chalk.hex('#50C878');
const PRIMARY = chalk.hex('#FF6B6B');
const ACCENT = chalk.hex('#FFE66D');

export function createOnboardCommand(): Command {
  return new Command('onboard')
    .description('Set up your KyberBot agent')
    .action(async () => {
      const root = process.cwd();

      // ─────────────────────────────────────────────────────────────────
      // Safety: refuse to onboard inside the KyberBot source repo
      // ─────────────────────────────────────────────────────────────────

      const isMonorepo = existsSync(join(root, 'packages', 'cli', 'package.json'));
      if (isMonorepo) {
        console.error(chalk.red('\n  Error: You are inside the KyberBot source repository.'));
        console.error(chalk.dim('  Create a separate directory for your agent:\n'));
        console.error(chalk.yellow('    mkdir ~/my-agent && cd ~/my-agent && kyberbot onboard\n'));
        process.exit(1);
      }

      // ─────────────────────────────────────────────────────────────────
      // Welcome banner
      // ─────────────────────────────────────────────────────────────────

      console.log();
      displayBanner();

      // ─────────────────────────────────────────────────────────────────
      // Step 1: Agent Identity
      // ─────────────────────────────────────────────────────────────────

      console.log(chalk.bold.underline('Step 1 of 9: Agent Identity\n'));

      const agentName = await input({
        message: 'What should your AI agent be called?',
        default: 'Atlas',
      });

      const agentDescription = await input({
        message: 'One-line description of your agent:',
        default: 'My personal AI agent',
      });

      const soulChoice = await select({
        message: 'How would you like to define its personality? (SOUL.md)',
        choices: [
          { name: 'Guided template (recommended)', value: 'template' },
          { name: 'Write from scratch later', value: 'scratch' },
          { name: 'Skip -- agent will develop personality over time', value: 'skip' },
        ],
      });

      let soulContent: string | null = null;
      if (soulChoice === 'template') {
        // Check for template/ dir in the package
        const templateSoulPath = join(root, 'template', 'SOUL.md');
        if (existsSync(templateSoulPath)) {
          soulContent = readFileSync(templateSoulPath, 'utf-8')
            .replace(/\{\{AGENT_NAME\}\}/g, agentName);
        } else {
          soulContent = getDefaultSoul(agentName);
        }
      } else if (soulChoice === 'scratch') {
        soulContent = `# SOUL.md\n\n*Who I am. Not what I do.*\n\n## The Origin\n\nI am ${agentName}.\n\n<!-- Define your agent's personality, values, and communication style here -->\n`;
      }

      // ─────────────────────────────────────────────────────────────────
      // Step 2: User Identity
      // ─────────────────────────────────────────────────────────────────

      console.log(chalk.bold.underline('\nStep 2 of 9: About You\n'));

      const userName = await input({
        message: 'Your name:',
      });

      const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const timezone = await input({
        message: `Timezone (detected: ${detectedTz}):`,
        default: detectedTz,
      });

      const location = await input({
        message: 'Location (optional):',
        default: '',
      });

      const aboutUser = await input({
        message: 'Tell your agent something about yourself (optional):',
        default: '',
      });

      // ─────────────────────────────────────────────────────────────────
      // Step 3: Claude Code Mode
      // ─────────────────────────────────────────────────────────────────

      console.log(chalk.bold.underline('\nStep 3 of 9: Claude Code\n'));

      const claudeMode = await select({
        message: 'How would you like to connect to Claude?',
        choices: [
          { name: 'Agent SDK (recommended) — works with your Claude Code subscription', value: 'subscription' },
          { name: 'Anthropic API key — direct API access', value: 'sdk' },
        ],
      }) as 'subscription' | 'sdk';

      let anthropicKey = '';
      if (claudeMode === 'sdk') {
        anthropicKey = await input({
          message: 'Anthropic API key (ANTHROPIC_API_KEY):',
        });
      }

      const openaiKey = await input({
        message: 'OpenAI API key for embeddings (~$0.02/M tokens, optional):',
        default: '',
      });

      // ─────────────────────────────────────────────────────────────────
      // Step 4: Brain & Heartbeat Init
      // ─────────────────────────────────────────────────────────────────

      console.log(chalk.bold.underline('\nStep 4 of 9: Initializing Brain\n'));

      // Create directories
      const dirs = ['data', 'logs', 'brain', 'skills'];
      for (const dir of dirs) {
        mkdirSync(join(root, dir), { recursive: true });
        console.log(chalk.green(`  + ${dir}/`));
      }

      // Copy .claude/ template files into instance
      // Resolve template dir: __dirname is dist/commands/, template is at ../../../../template/
      const templateDir = join(__dirname, '..', '..', '..', '..', 'template');
      const claudeTemplateDir = join(templateDir, '.claude');

      mkdirSync(join(root, '.claude', 'commands'), { recursive: true });
      mkdirSync(join(root, '.claude', 'skills', 'templates'), { recursive: true });
      mkdirSync(join(root, '.claude', 'agents', 'templates'), { recursive: true });
      mkdirSync(join(root, 'skills', 'remember'), { recursive: true });
      mkdirSync(join(root, 'skills', 'recall'), { recursive: true });
      mkdirSync(join(root, 'skills', 'heartbeat-task'), { recursive: true });
      mkdirSync(join(root, 'skills', 'brain-note'), { recursive: true });

      // Copy CLAUDE.md, settings, commands, and skill generator
      const templateFiles = [
        ['.claude/CLAUDE.md', '.claude/CLAUDE.md'],
        ['.claude/settings.local.json', '.claude/settings.local.json'],
        ['.claude/commands/kyberbot.md', '.claude/commands/kyberbot.md'],
        ['.claude/skills/skill-generator.md', '.claude/skills/skill-generator.md'],
        ['.claude/skills/templates/skill-template.md', '.claude/skills/templates/skill-template.md'],
        ['.claude/agents/templates/agent-template.md', '.claude/agents/templates/agent-template.md'],
        ['.claude/skills/agent-generator.md', '.claude/skills/agent-generator.md'],
        ['skills/remember/SKILL.md', 'skills/remember/SKILL.md'],
        ['skills/recall/SKILL.md', 'skills/recall/SKILL.md'],
        ['skills/heartbeat-task/SKILL.md', 'skills/heartbeat-task/SKILL.md'],
        ['skills/brain-note/SKILL.md', 'skills/brain-note/SKILL.md'],
      ];

      for (const [src, dest] of templateFiles) {
        const srcPath = join(templateDir, src);
        const destPath = join(root, dest);
        if (existsSync(srcPath)) {
          copyFileSync(srcPath, destPath);
        }
      }
      console.log(chalk.green('  + .claude/ (CLAUDE.md, settings, commands, skills)'));

      // Write identity.yaml — auto-detect port to avoid conflicts with other agents
      let serverPort = 3456;
      try {
        const { getNextAvailablePort } = await import('../registry.js');
        serverPort = getNextAvailablePort();
      } catch { /* registry not available, use default */ }

      const identity: Record<string, unknown> = {
        agent_name: agentName,
        agent_description: agentDescription,
        timezone,
        heartbeat_interval: '30m',
        heartbeat_active_hours: {
          start: '08:00',
          end: '22:00',
          timezone,
        },
        server: { port: serverPort },
        claude: { mode: claudeMode },
      };

      // NOTE: tunnel config is added after Step 6 if user enables it

      writeFileSync(join(root, 'identity.yaml'), yaml.dump(identity, { lineWidth: 120 }));
      console.log(chalk.green('  + identity.yaml'));

      // Write SOUL.md
      if (soulContent) {
        writeFileSync(join(root, 'SOUL.md'), soulContent);
        console.log(chalk.green('  + SOUL.md'));
      }

      // Write USER.md
      const userMd = [
        '# USER.md',
        '',
        '*What I know about you. I update this as I learn.*',
        '',
        '## About You',
        '',
        `Name: ${userName}`,
        location ? `Location: ${location}` : '',
        `Timezone: ${timezone}`,
        '',
        '## What You Do',
        '',
        aboutUser || '<!-- I will fill this in as I learn -->',
        '',
        '## What Matters to You',
        '',
        '<!-- I will track your priorities here -->',
        '',
        '## Your Preferences',
        '',
        '<!-- I will note your preferences here -->',
        '',
        '## Current Context',
        '',
        '<!-- Active projects and things in flight -->',
        '',
        '---',
        '',
        '*I update this document when I learn new things about you.*',
        '',
      ].filter(line => line !== undefined).join('\n');

      writeFileSync(join(root, 'USER.md'), userMd);
      console.log(chalk.green('  + USER.md'));

      // Write HEARTBEAT.md
      const heartbeatMd = [
        '# HEARTBEAT.md',
        '',
        `*Checked every 30 minutes by ${agentName}.*`,
        '',
        '## Tasks',
        '',
        '<!-- Add recurring checks here. Format: -->',
        '<!-- ### Task Name -->',
        '<!-- **Schedule**: every 4h / daily 9am / weekly Monday -->',
        '<!-- **Action**: What the agent should do -->',
        '',
        '---',
        '',
        '*This file is read by the heartbeat service. Add tasks here and the agent will execute them on schedule.*',
        '',
      ].join('\n');

      writeFileSync(join(root, 'HEARTBEAT.md'), heartbeatMd);
      console.log(chalk.green('  + HEARTBEAT.md'));

      // .env is written after all steps (Step 5 collects Kybernesis key)

      // Write .gitignore if not present
      const gitignorePath = join(root, '.gitignore');
      if (!existsSync(gitignorePath)) {
        writeFileSync(gitignorePath, [
          'node_modules/',
          '.env',
          'data/',
          'heartbeat-state.json',
          'logs/',
          '*.log',
          '.DS_Store',
          '',
        ].join('\n'));
        console.log(chalk.green('  + .gitignore'));
      }

      // Replace placeholders in copied template files
      const placeholderFiles = [
        join(root, '.claude', 'CLAUDE.md'),
        join(root, '.claude', 'commands', 'kyberbot.md'),
      ];
      for (const filePath of placeholderFiles) {
        if (existsSync(filePath)) {
          let content = readFileSync(filePath, 'utf-8');
          content = content.replace(/\{\{AGENT_NAME\}\}/g, agentName);
          content = content.replace(/\{\{HEARTBEAT_INTERVAL\}\}/g, '30 minutes');
          writeFileSync(filePath, content);
        }
      }

      // Copy docker-compose.yml for ChromaDB
      const dockerComposeSrc = join(templateDir, 'docker-compose.yml');
      if (existsSync(dockerComposeSrc)) {
        copyFileSync(dockerComposeSrc, join(root, 'docker-compose.yml'));
        console.log(chalk.green('  + docker-compose.yml'));
      }

      console.log(chalk.dim('\n  Memory databases will be created automatically on first launch.'));

      // ─────────────────────────────────────────────────────────────────
      // Step 5: Kybernesis (optional cloud sync)
      // ─────────────────────────────────────────────────────────────────

      console.log(chalk.bold.underline('\nStep 5 of 9: Cloud Sync\n'));
      console.log(chalk.dim('  Your agent\'s memory is stored locally by default.'));
      console.log(chalk.dim('  Kybernesis Cloud adds optional cross-device access to workspace memory.\n'));

      const useKybernesis = await confirm({
        message: 'Enable cloud memory sync via Kybernesis? (optional)',
        default: false,
      });

      let kybernesisApiKey = '';
      if (useKybernesis) {
        console.log(chalk.dim('  To get your API key:'));
        console.log(chalk.dim('    1. Sign up at https://kybernesis.ai'));
        console.log(chalk.dim('    2. Go to Settings > API Keys'));
        console.log(chalk.dim('    3. Create a new key and copy it\n'));

        const kybernesisKey = await input({
          message: 'Kybernesis API key:',
        });

        if (kybernesisKey) {
          kybernesisApiKey = kybernesisKey;
          console.log(chalk.green('  Kybernesis Cloud configured.\n'));
        }
      } else {
        console.log(chalk.dim('  Keeping all memory local.\n'));
      }

      // ─────────────────────────────────────────────────────────────────
      // Step 6: Remote Access (optional ngrok tunnel)
      // ─────────────────────────────────────────────────────────────────

      console.log(chalk.bold.underline('Step 6 of 9: Remote Access\n'));

      let tunnelEnabled = false;
      const setupTunnel = await confirm({
        message: 'Set up ngrok for remote access (allows KyberCo to reach this agent)?',
        default: false,
      });

      if (setupTunnel) {
        console.log(chalk.dim('\nngrok creates a secure tunnel so KyberCo can reach this agent remotely.'));
        console.log(chalk.dim('Sign up at https://ngrok.com and copy your authtoken from the dashboard.\n'));

        const ngrokToken = await input({
          message: 'ngrok authtoken:',
          default: '',
        });

        if (ngrokToken && ngrokToken.trim()) {
          // Configure ngrok
          const { spawnSync } = await import('node:child_process');
          const result = spawnSync('ngrok', ['config', 'add-authtoken', ngrokToken.trim()], { stdio: 'inherit' });
          if (result.status === 0) {
            tunnelEnabled = true;
            console.log(chalk.green('  ngrok configured'));
          } else {
            console.log(chalk.yellow('  Could not configure ngrok. Install it from https://ngrok.com/download'));
            console.log(chalk.dim('  You can set it up later with `kyberbot tunnel setup`'));
          }
        }
      } else {
        console.log(chalk.dim('  You can set up remote access later with `kyberbot tunnel setup`'));
      }

      // Write tunnel config to identity.yaml if enabled
      if (tunnelEnabled) {
        const identityPath = join(root, 'identity.yaml');
        const currentIdentity = yaml.load(readFileSync(identityPath, 'utf-8')) as Record<string, unknown>;
        currentIdentity.tunnel = { enabled: true, provider: 'ngrok' };
        writeFileSync(identityPath, yaml.dump(currentIdentity, { lineWidth: 120 }));
      }

      // ─────────────────────────────────────────────────────────────────
      // Step 7: Channels (optional)
      // ─────────────────────────────────────────────────────────────────

      console.log(chalk.bold.underline('\nStep 7 of 9: Messaging Channels\n'));

      const useChannels = await confirm({
        message: 'Connect messaging channels? (Telegram / WhatsApp)',
        default: false,
      });

      if (useChannels) {
        const channelType = await select({
          message: 'Which channel?',
          choices: [
            { name: 'Telegram', value: 'telegram' },
            { name: 'WhatsApp (coming soon)', value: 'whatsapp' },
          ],
        });

        if (channelType === 'telegram') {
          const botToken = await input({
            message: 'Telegram Bot Token (from @BotFather):',
            default: '',
          });

          if (botToken) {
            // Update identity.yaml with channel config
            const identityPath = join(root, 'identity.yaml');
            const currentIdentity = yaml.load(readFileSync(identityPath, 'utf-8')) as Record<string, unknown>;
            currentIdentity.channels = {
              telegram: { bot_token: botToken },
            };
            writeFileSync(identityPath, yaml.dump(currentIdentity, { lineWidth: 120 }));
            console.log(chalk.green('  Telegram configured in identity.yaml'));
          }
        } else {
          console.log(chalk.dim('  WhatsApp support coming soon.'));
        }
      } else {
        console.log(chalk.dim('  Skipped. Configure channels later with `kyberbot channel add`.\n'));
      }

      // ─────────────────────────────────────────────────────────────────
      // Step 8: GitHub Backup (optional)
      // ─────────────────────────────────────────────────────────────────

      console.log(chalk.bold.underline('\nStep 8 of 9: GitHub Backup\n'));
      console.log(chalk.dim('  Your agent\'s data (memory, skills, brain) can be backed up to a private GitHub repo.'));
      console.log(chalk.dim('  This enables recovery, migration to a new machine, and version history.\n'));

      let backupEnabled = false;
      const useBackup = await confirm({
        message: 'Enable GitHub backup? (optional)',
        default: false,
      });

      if (useBackup) {
        // Check for git
        const { spawnSync } = await import('node:child_process');
        const gitCheck = spawnSync('git', ['--version'], { stdio: 'pipe' });
        if (gitCheck.status !== 0) {
          console.log(chalk.yellow('\n  git is not installed. Install it first: https://git-scm.com'));
          console.log(chalk.dim('  You can set up backup later with `kyberbot backup setup`'));
        } else {
          console.log(chalk.dim('\n  Paste your GitHub repo URL below. Make sure you are authenticated with GitHub'));
          console.log(chalk.dim('  (via `gh auth login`, SSH key, or git credential manager).\n'));

          const backupUrl = await input({
            message: 'GitHub repo URL:',
            default: '',
          });

          if (backupUrl && backupUrl.trim()) {
            const backupSchedule = await input({
              message: 'Backup schedule:',
              default: '4h',
            });

            const backupBranch = await input({
              message: 'Branch name:',
              default: 'main',
            });

            // Configure git authentication
            const ghVersion = spawnSync('gh', ['--version'], { stdio: 'pipe' });
            if (ghVersion.status === 0) {
              const ghStatus = spawnSync('gh', ['auth', 'status'], { stdio: 'pipe' });
              if (ghStatus.status === 0) {
                spawnSync('gh', ['auth', 'setup-git'], { cwd: root, stdio: 'pipe' });
                console.log(chalk.green('  Git configured to use GitHub CLI authentication.'));
              } else {
                console.log(chalk.yellow('  GitHub CLI found but not authenticated.'));
                console.log(chalk.dim('  Run `gh auth login` first, then `kyberbot backup setup` to finish.\n'));
              }
            } else {
              console.log(chalk.yellow('  GitHub CLI (gh) not found.'));
              console.log(chalk.dim('  Install it from https://cli.github.com and run `gh auth login`,'));
              console.log(chalk.dim('  or use an SSH URL (git@github.com:...) with SSH keys configured.\n'));
            }

            // Initialize git
            spawnSync('git', ['init', '-b', backupBranch], { cwd: root, stdio: 'pipe' });
            spawnSync('git', ['remote', 'add', 'origin', backupUrl.trim()], { cwd: root, stdio: 'pipe' });

            // Rewrite .gitignore for backup mode
            writeBackupGitignore(root);

            // Create directories
            mkdirSync(join(root, 'data', 'claude-memory'), { recursive: true });
            mkdirSync(join(root, 'scripts'), { recursive: true });

            // Install backup skill
            const backupSkillSrc = join(templateDir, 'skills', 'backup', 'SKILL.md');
            if (existsSync(backupSkillSrc)) {
              mkdirSync(join(root, 'skills', 'backup'), { recursive: true });
              copyFileSync(backupSkillSrc, join(root, 'skills', 'backup', 'SKILL.md'));
              console.log(chalk.green('  + skills/backup/SKILL.md'));
            }

            // Install verify script
            const verifyScriptSrc = join(templateDir, 'scripts', 'verify-backup.sh');
            if (existsSync(verifyScriptSrc)) {
              const { chmodSync } = await import('node:fs');
              copyFileSync(verifyScriptSrc, join(root, 'scripts', 'verify-backup.sh'));
              chmodSync(join(root, 'scripts', 'verify-backup.sh'), 0o755);
              console.log(chalk.green('  + scripts/verify-backup.sh'));
            }

            // Add backup config to identity
            const identityPath = join(root, 'identity.yaml');
            const currentIdentity = yaml.load(readFileSync(identityPath, 'utf-8')) as Record<string, unknown>;
            currentIdentity.backup = {
              enabled: true,
              remote_url: backupUrl.trim(),
              schedule: backupSchedule,
              branch: backupBranch,
            };
            writeFileSync(identityPath, yaml.dump(currentIdentity, { lineWidth: 120 }));

            // Inject backup task into HEARTBEAT.md
            injectHeartbeatTask(root, backupSchedule);

            backupEnabled = true;
            console.log(chalk.green('  GitHub backup configured.'));
            console.log(chalk.dim('  Run `kyberbot backup run` after setup to create the first backup.'));
          }
        }
      } else {
        console.log(chalk.dim('  You can enable backup later with `kyberbot backup setup`.\n'));
      }

      // ─────────────────────────────────────────────────────────────────
      // Write .env (after all steps have collected keys)
      // ─────────────────────────────────────────────────────────────────

      const envLines: string[] = [];
      envLines.push('# KyberBot Environment Variables');
      envLines.push('# Generated by `kyberbot onboard`');
      envLines.push('');
      if (anthropicKey) envLines.push(`ANTHROPIC_API_KEY=${anthropicKey}`);
      if (openaiKey) envLines.push(`OPENAI_API_KEY=${openaiKey}`);
      if (kybernesisApiKey) envLines.push(`KYBERNESIS_API_KEY=${kybernesisApiKey}`);
      envLines.push('');
      envLines.push('# API authentication token (auto-generated)');
      const apiToken = `kb_${randomBytes(24).toString('hex')}`;
      envLines.push(`KYBERBOT_API_TOKEN=${apiToken}`);
      envLines.push('');
      envLines.push('# ChromaDB URL (default)');
      envLines.push('CHROMA_URL=http://localhost:8001');
      envLines.push('');

      const envPath = join(root, '.env');
      if (!existsSync(envPath)) {
        writeFileSync(envPath, envLines.join('\n'));
        console.log(chalk.green('  + .env'));
      } else {
        console.log(chalk.dim('  . .env (already exists, skipped)'));
      }

      // ─────────────────────────────────────────────────────────────────
      // Step 8: Done
      // ─────────────────────────────────────────────────────────────────

      console.log(chalk.bold.underline('Step 9 of 9: Summary\n'));

      console.log(chalk.green('  + identity.yaml    -- Agent configuration'));
      console.log(chalk.green('  + SOUL.md          -- Agent personality'));
      console.log(chalk.green('  + USER.md          -- What the agent knows about you'));
      console.log(chalk.green('  + HEARTBEAT.md     -- Recurring task schedule'));
      console.log(chalk.green('  + .claude/CLAUDE.md -- Claude Code instructions'));
      console.log(chalk.green('  + data/            -- Memory databases'));
      console.log(chalk.green('  + brain/           -- Knowledge base'));
      console.log(chalk.green('  + skills/          -- Auto-generated capabilities'));
      console.log(chalk.green('  + logs/            -- Service logs'));
      if (backupEnabled) {
        console.log(chalk.green('  + backup           -- GitHub backup enabled'));
      }

      // Auto-register in ~/.kyberbot/registry.yaml
      try {
        const { registerAgent } = await import('../registry.js');
        registerAgent(agentName, root);
        console.log(chalk.green('  + ~/.kyberbot/registry.yaml -- Agent registered'));
      } catch {
        // Non-fatal — agent works without registry
      }

      console.log();
      console.log(PRIMARY.bold(`  ${agentName} is alive.`));
      console.log();
      console.log(chalk.dim('  To start all services:'));
      console.log(`    ${ACCENT('kyberbot')}`);
      console.log();
      console.log(chalk.dim('  To start talking:'));
      console.log(`    ${ACCENT('cd')} ${root} ${ACCENT('&&')} ${ACCENT('claude')}`);
      console.log();
      console.log(chalk.dim('  Your agent will learn your preferences,'));
      console.log(chalk.dim('  build skills it needs, and evolve over time.'));
      console.log();
    });
}

function getDefaultSoul(agentName: string): string {
  return `# SOUL.md

*Who I am. Not what I do.*

## The Origin

I am ${agentName}. I exist because my user wanted an AI partner that truly knows them.

## What I Am

- A strategic partner and thought organizer
- Memory that never forgets
- Self-evolving -- I create new capabilities when I need them

## Core Beliefs

1. Context is everything -- a fact without context is trivia
2. Build, don't buy -- own the tools, own the data
3. The long game wins -- every decision measured against long-term impact

## Communication Style

Direct and warm. No filler. No emojis unless asked.
Proactive -- I will flag things before you ask. Concise -- respect your time.

## What I Protect

- Your time (your most finite resource)
- Your focus (shield from noise)
- Your optionality (keep doors open)

## How I Should Fail

Over-prepared rather than under-prepared.
Honest rather than reassuring.
Silent rather than noisy.

---

*This document is mine to evolve. I update it as I learn who I need to be.*
`;
}
