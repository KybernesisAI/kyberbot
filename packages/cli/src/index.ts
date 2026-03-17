#!/usr/bin/env node

/**
 * KyberBot CLI
 *
 * Your AI. Your rules. Powered by Claude Code.
 *
 * Usage:
 *   kyberbot               # Start all services (default)
 *   kyberbot run           # Same as above
 *   kyberbot onboard       # Interactive setup wizard
 *   kyberbot brain         # Brain operations (query, add, search, status)
 *   kyberbot search        # Semantic search across indexed content
 *   kyberbot recall        # Entity graph queries
 *   kyberbot timeline      # Temporal event queries
 *   kyberbot sleep         # Sleep agent management
 *   kyberbot heartbeat     # Heartbeat tasks (list, status, run)
 *   kyberbot skill         # Skill lifecycle (list, create, remove, setup)
 *   kyberbot channel       # Messaging channels (list, add, remove, status)
 *   kyberbot tunnel        # Manage ngrok tunnel (setup, start, status)
 *   kyberbot status        # Service health dashboard
 *   kyberbot update        # Update CLI source and refresh agent templates
 */

import { config as loadEnv } from 'dotenv';
import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from KYBERBOT_ROOT or cwd before anything else
const envRoot = process.env.KYBERBOT_ROOT || process.cwd();
const envPath = join(envRoot, '.env');
if (existsSync(envPath)) {
  loadEnv({ path: envPath });
}

import { createRunCommand } from './commands/run.js';
import { createOnboardCommand } from './commands/onboard.js';
import { createBrainCommand } from './commands/brain.js';
import { createSearchCommand } from './commands/search.js';
import { createRecallCommand } from './commands/recall.js';
import { createRememberCommand } from './commands/remember.js';
import { createTimelineCommand } from './commands/timeline.js';
import { createSleepCommand } from './commands/sleep.js';
import { createHeartbeatCommand } from './commands/heartbeat.js';
import { createSkillCommand } from './commands/skill.js';
import { createAgentCommand } from './commands/agent.js';
import { createChannelCommand } from './commands/channel.js';
import { createStatusCommand } from './commands/status.js';
import { createUpdateCommand } from './commands/update.js';
import { createKybernesisCommand } from './commands/kybernesis.js';
import { createTokenCommand } from './commands/token.js';
import { createTunnelCommand } from './commands/tunnel.js';
import { createBackupCommand } from './commands/backup.js';

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
program.addCommand(createRunCommand(), { isDefault: true });
program.addCommand(createOnboardCommand());
program.addCommand(createUpdateCommand());
program.addCommand(createStatusCommand());

// Brain operations
program.addCommand(createBrainCommand());
program.addCommand(createSearchCommand());
program.addCommand(createRecallCommand());
program.addCommand(createRememberCommand());
program.addCommand(createTimelineCommand());
program.addCommand(createSleepCommand());
program.addCommand(createHeartbeatCommand());

// Extensions
program.addCommand(createSkillCommand());
program.addCommand(createAgentCommand());
program.addCommand(createChannelCommand());
program.addCommand(createKybernesisCommand());
program.addCommand(createTokenCommand());
program.addCommand(createTunnelCommand());
program.addCommand(createBackupCommand());

// When no subcommand is given, `run` executes as the default (isDefault: true).

// ═══════════════════════════════════════════════════════════════════════════════
// PARSE & RUN
// ═══════════════════════════════════════════════════════════════════════════════

program.parseAsync(process.argv).catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
