/**
 * Onboard Command
 *
 * Interactive setup wizard with 7 steps:
 *   Step 1: Agent identity (name, description, SOUL.md choice)
 *   Step 2: User identity (name, timezone, location, about)
 *   Step 3: Claude Code mode (subscription vs SDK)
 *   Step 4: Brain & heartbeat init (mkdir data/, init memory DBs)
 *   Step 5: Kybernesis (optional cloud sync)
 *   Step 6: Channels (Telegram/WhatsApp - optional)
 *   Step 7: Done - show summary
 *
 * Usage:
 *   kyberbot onboard
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import yaml from 'js-yaml';
import { input, select, confirm } from '@inquirer/prompts';

import { displayBanner } from '../splash.js';

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

      console.log(chalk.bold.underline('Step 1 of 7: Agent Identity\n'));

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

      console.log(chalk.bold.underline('\nStep 2 of 7: About You\n'));

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

      console.log(chalk.bold.underline('\nStep 3 of 7: Claude Code\n'));

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

      console.log(chalk.bold.underline('\nStep 4 of 7: Initializing Brain\n'));

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
      mkdirSync(join(root, '.claude', 'agents'), { recursive: true });

      // Copy CLAUDE.md, settings, commands, and skill generator
      const templateFiles = [
        ['.claude/CLAUDE.md', '.claude/CLAUDE.md'],
        ['.claude/settings.local.json', '.claude/settings.local.json'],
        ['.claude/commands/kyberbot.md', '.claude/commands/kyberbot.md'],
        ['.claude/skills/skill-generator.md', '.claude/skills/skill-generator.md'],
        ['.claude/skills/templates/skill-template.md', '.claude/skills/templates/skill-template.md'],
      ];

      for (const [src, dest] of templateFiles) {
        const srcPath = join(templateDir, src);
        const destPath = join(root, dest);
        if (existsSync(srcPath)) {
          copyFileSync(srcPath, destPath);
        }
      }
      console.log(chalk.green('  + .claude/ (CLAUDE.md, settings, commands, skills)'));

      // Write identity.yaml
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
        server: { port: 3456 },
        claude: { mode: claudeMode },
      };

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

      console.log(chalk.bold.underline('\nStep 5 of 7: Cloud Sync\n'));
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
      // Step 6: Channels (optional)
      // ─────────────────────────────────────────────────────────────────

      console.log(chalk.bold.underline('Step 6 of 7: Messaging Channels\n'));

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
      // Step 7: Done
      // ─────────────────────────────────────────────────────────────────

      console.log(chalk.bold.underline('Step 7 of 7: Summary\n'));

      console.log(chalk.green('  + identity.yaml    -- Agent configuration'));
      console.log(chalk.green('  + SOUL.md          -- Agent personality'));
      console.log(chalk.green('  + USER.md          -- What the agent knows about you'));
      console.log(chalk.green('  + HEARTBEAT.md     -- Recurring task schedule'));
      console.log(chalk.green('  + .claude/CLAUDE.md -- Claude Code instructions'));
      console.log(chalk.green('  + data/            -- Memory databases'));
      console.log(chalk.green('  + brain/           -- Knowledge base'));
      console.log(chalk.green('  + skills/          -- Auto-generated capabilities'));
      console.log(chalk.green('  + logs/            -- Service logs'));

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
