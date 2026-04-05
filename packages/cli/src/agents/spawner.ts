/**
 * KyberBot — Agent Spawner
 *
 * Bridges agent definitions to Claude execution.
 * Loads an agent's .md file, builds a system prompt with identity context,
 * and runs the prompt through ClaudeClient.complete().
 */

import { readFileSync, existsSync } from 'fs';
import { getAgentName, getRoot } from '../config.js';
import { getClaudeClient, CompleteOptions } from '../claude.js';
import { getAgent } from './loader.js';
import { InstalledAgent, AgentSpawnResult } from './types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-spawner');

/**
 * Spawn a sub-agent by name with a user prompt.
 * Builds the system prompt from the agent definition + identity context,
 * then executes via ClaudeClient.
 */
export async function spawnAgent(name: string, prompt: string): Promise<AgentSpawnResult> {
  const agent = getAgent(name);

  if (!agent) {
    throw new Error(`Agent not found: ${name}. Run \`kyberbot agent list\` to see available agents.`);
  }

  const systemPrompt = buildSystemPrompt(agent);
  const client = getClaudeClient();

  const start = Date.now();

  const opts: CompleteOptions = {
    model: agent.model as CompleteOptions['model'],
    system: systemPrompt,
    maxTurns: agent.maxTurns,
    subprocess: true,
  };

  logger.info(`Spawning agent: ${name}`, { model: agent.model, maxTurns: agent.maxTurns });

  const response = await client.complete(prompt, opts);
  const durationMs = Date.now() - start;

  logger.info(`Agent ${name} completed`, { durationMs });

  return {
    agent: name,
    prompt,
    response,
    model: agent.model,
    durationMs,
  };
}

/**
 * Build the full system prompt for a sub-agent.
 * Structure: preamble + agent body + abbreviated identity context.
 */
export function buildSystemPrompt(agent: InstalledAgent): string {
  const parts: string[] = [];
  const root = getRoot();

  // Preamble: who you are and delegation context
  let agentName: string;
  try {
    agentName = getAgentName();
  } catch {
    agentName = 'KyberBot';
  }

  parts.push(`You are a sub-agent of ${agentName}, delegated a specific task.`);
  parts.push(`Your role: ${agent.role}`);
  parts.push(`Your name: ${agent.name}`);
  parts.push('');
  parts.push('You have been spawned to handle a specific task. Complete it thoroughly and return your findings.');
  parts.push('');

  // Agent body (instructions from the .md file)
  if (agent.systemPromptBody) {
    parts.push(agent.systemPromptBody);
    parts.push('');
  }

  // Abbreviated SOUL.md for identity awareness
  try {
    const soulPath = `${root}/SOUL.md`;
    if (existsSync(soulPath)) {
      const soul = readFileSync(soulPath, 'utf-8');
      // Include first ~500 chars for context, not the full file
      const abbreviated = soul.length > 500 ? soul.slice(0, 500) + '\n...' : soul;
      parts.push('## Parent Agent Identity (abbreviated)');
      parts.push(abbreviated);
      parts.push('');
    }
  } catch {
    // Non-fatal
  }

  // Abbreviated USER.md for user awareness
  try {
    const userPath = `${root}/USER.md`;
    if (existsSync(userPath)) {
      const user = readFileSync(userPath, 'utf-8');
      const abbreviated = user.length > 500 ? user.slice(0, 500) + '\n...' : user;
      parts.push('## User Context (abbreviated)');
      parts.push(abbreviated);
      parts.push('');
    }
  } catch {
    // Non-fatal
  }

  return parts.join('\n');
}

