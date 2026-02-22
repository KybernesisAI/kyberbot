#!/usr/bin/env node

/**
 * KyberBot CLI
 *
 * Your AI. Your rules. Powered by Claude Code.
 *
 * Usage:
 *   kyberbot run           # Start all services
 *   kyberbot onboard       # Interactive setup wizard
 *   kyberbot brain         # Brain operations (query, add, search, status)
 *   kyberbot search        # Semantic search across indexed content
 *   kyberbot recall        # Entity graph queries
 *   kyberbot timeline      # Temporal event queries
 *   kyberbot sleep         # Sleep agent management
 *   kyberbot skill         # Skill lifecycle (list, create, remove, setup)
 *   kyberbot channel       # Messaging channels (list, add, remove, status)
 *   kyberbot status        # Service health dashboard
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { createRunCommand } from './commands/run.js';
import { createOnboardCommand } from './commands/onboard.js';
import { createBrainCommand } from './commands/brain.js';
import { createSearchCommand } from './commands/search.js';
import { createRecallCommand } from './commands/recall.js';
import { createTimelineCommand } from './commands/timeline.js';
import { createSleepCommand } from './commands/sleep.js';
import { createSkillCommand } from './commands/skill.js';
import { createChannelCommand } from './commands/channel.js';
import { createStatusCommand } from './commands/status.js';

// ═══════════════════════════════════════════════════════════════════════════════
// VERSION
// ═══════════════════════════════════════════════════════════════════════════════

const __dirname = dirname(fileURLToPath(import.meta.url));
let version = '0.1.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  version = pkg.version || version;
} catch {
  // Use default version
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROGRAM SETUP
// ═══════════════════════════════════════════════════════════════════════════════

const program = new Command();

program
  .name('kyberbot')
  .description('Your AI. Your rules. Powered by Claude Code.')
  .version(version);

// ═══════════════════════════════════════════════════════════════════════════════
// REGISTER COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

// Core lifecycle
program.addCommand(createRunCommand());
program.addCommand(createOnboardCommand());
program.addCommand(createStatusCommand());

// Brain operations
program.addCommand(createBrainCommand());
program.addCommand(createSearchCommand());
program.addCommand(createRecallCommand());
program.addCommand(createTimelineCommand());
program.addCommand(createSleepCommand());

// Extensions
program.addCommand(createSkillCommand());
program.addCommand(createChannelCommand());

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT ACTION
// ═══════════════════════════════════════════════════════════════════════════════

program.action(() => {
  program.help();
});

// ═══════════════════════════════════════════════════════════════════════════════
// PARSE & RUN
// ═══════════════════════════════════════════════════════════════════════════════

program.parseAsync(process.argv).catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
