/**
 * Agent Command
 *
 * Sub-agent lifecycle management: list, create, remove, info, spawn, rebuild.
 *
 * Usage:
 *   kyberbot agent list              # Show installed agents
 *   kyberbot agent create <name>     # Scaffold a new agent from template
 *   kyberbot agent remove <name>     # Remove an agent
 *   kyberbot agent info <name>       # Show agent details
 *   kyberbot agent spawn <name>      # Spawn agent with a prompt
 *   kyberbot agent rebuild           # Rebuild CLAUDE.md with current agents
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { loadInstalledAgents, getAgent } from '../agents/loader.js';
import { scaffoldAgent } from '../agents/scaffolder.js';
import { removeAgent } from '../agents/registry.js';
import { spawnAgent } from '../agents/spawner.js';
import { rebuildClaudeMd } from '../skills/registry.js';

export function createAgentCommand(): Command {
  const cmd = new Command('agent')
    .description('Manage sub-agents');

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot agent list
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('list')
    .description('Show installed agents')
    .option('--json', 'Output as JSON', false)
    .action((options: { json: boolean }) => {
      const agents = loadInstalledAgents();

      if (options.json) {
        console.log(JSON.stringify(agents, null, 2));
        return;
      }

      console.log(chalk.cyan.bold('\nInstalled Agents\n'));

      if (agents.length === 0) {
        console.log(chalk.dim('  No agents installed yet.'));
        console.log(chalk.dim('  Run `kyberbot agent create <name>` to scaffold one.\n'));
        return;
      }

      for (const agent of agents) {
        const model = chalk.dim(`(${agent.model})`);
        console.log(`  ${chalk.white.bold(agent.name)} ${model}`);
        if (agent.description) {
          console.log(chalk.dim(`           ${agent.description}`));
        }
        if (agent.role) {
          console.log(chalk.dim(`           Role: ${agent.role}`));
        }
      }

      console.log('');
      console.log(chalk.dim(`  ${agents.length} agent(s) installed`));
      console.log('');
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot agent create <name>
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('create')
    .description('Scaffold a new agent from template')
    .argument('<name>', 'Agent name (lowercase, hyphens ok)')
    .option('-d, --description <desc>', 'Agent description', '')
    .option('-r, --role <role>', 'Agent role/persona', '')
    .option('-m, --model <model>', 'Model to use (haiku, sonnet, opus)', 'opus')
    .option('-t, --max-turns <turns>', 'Maximum turns', '10')
    .action((name: string, options: { description: string; role: string; model: string; maxTurns: string }) => {
      try {
        const agentPath = scaffoldAgent({
          name,
          description: options.description || `${name} agent`,
          role: options.role || `A specialized ${name} agent`,
          model: options.model,
          maxTurns: parseInt(options.maxTurns, 10),
        });

        console.log(chalk.green(`\nAgent scaffolded: ${name}`));
        console.log(chalk.dim(`  Path: ${agentPath}`));
        console.log(chalk.dim('  Edit the .md file to define the agent\'s instructions.'));
        console.log('');

        // Rebuild CLAUDE.md to include the new agent
        rebuildClaudeMd();
        console.log(chalk.dim('  CLAUDE.md updated with new agent.'));
        console.log('');
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot agent remove <name>
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('remove')
    .description('Remove an installed agent')
    .argument('<name>', 'Agent name')
    .action((name: string) => {
      const removed = removeAgent(name);

      if (removed) {
        rebuildClaudeMd();
        console.log(chalk.green(`\nAgent "${name}" removed.`));
        console.log(chalk.dim('  CLAUDE.md updated.\n'));
      } else {
        console.log(chalk.yellow(`\nAgent "${name}" not found.`));
        console.log(chalk.dim('  Run `kyberbot agent list` to see available agents.\n'));
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot agent info <name>
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('info')
    .description('Show details about an installed agent')
    .argument('<name>', 'Agent name')
    .action((name: string) => {
      const agent = getAgent(name);

      if (!agent) {
        console.error(chalk.red(`Agent not found: ${name}`));
        console.log(chalk.dim('  Run `kyberbot agent list` to see available agents.\n'));
        process.exit(1);
      }

      console.log('');
      console.log(`  ${chalk.cyan.bold(agent.name)} ${chalk.dim(`(${agent.model})`)}`);
      console.log(`  ${agent.description}`);
      console.log('');
      console.log(chalk.dim(`  Role:       ${agent.role}`));
      console.log(chalk.dim(`  Path:       ${agent.path}`));
      console.log(chalk.dim(`  Model:      ${agent.model}`));
      console.log(chalk.dim(`  Max Turns:  ${agent.maxTurns}`));

      if (agent.allowedTools.length > 0) {
        console.log(chalk.dim(`  Tools:      ${agent.allowedTools.join(', ')}`));
      }

      // Show first 10 lines of instructions
      if (agent.systemPromptBody) {
        const lines = agent.systemPromptBody.split('\n').slice(0, 10);
        console.log('');
        console.log(chalk.dim('  Instructions (first 10 lines):'));
        for (const line of lines) {
          console.log(chalk.dim(`    ${line}`));
        }
        const totalLines = agent.systemPromptBody.split('\n').length;
        if (totalLines > 10) {
          console.log(chalk.dim(`    ... (${totalLines - 10} more lines)`));
        }
      }

      console.log('');
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot agent spawn <name> <prompt>
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('spawn')
    .description('Spawn an agent with a prompt')
    .argument('<name>', 'Agent name')
    .argument('<prompt>', 'Task prompt for the agent')
    .action(async (name: string, prompt: string) => {
      try {
        console.log(chalk.dim(`\nSpawning agent: ${name}...`));
        console.log(chalk.dim(`  Prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}\n`));

        const result = await spawnAgent(name, prompt);

        console.log(chalk.cyan.bold(`\n--- ${name} response ---\n`));
        console.log(result.response);
        console.log(chalk.dim(`\n--- completed in ${(result.durationMs / 1000).toFixed(1)}s (${result.model}) ---\n`));
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot agent rebuild
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('rebuild')
    .description('Rebuild CLAUDE.md with current agents')
    .action(() => {
      try {
        rebuildClaudeMd();
        console.log(chalk.green('\nCLAUDE.md rebuilt with current agents.\n'));
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  return cmd;
}
