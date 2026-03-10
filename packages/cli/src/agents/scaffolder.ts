/**
 * KyberBot — Agent Scaffolder
 *
 * Generates new agent .md files from the template.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { paths } from '../config.js';
import { createLogger } from '../logger.js';

const logger = createLogger('agents');

export interface AgentScaffoldOptions {
  name: string;
  description: string;
  role?: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
}

/**
 * Create a new agent from template
 */
export function scaffoldAgent(options: AgentScaffoldOptions): string {
  const agentPath = join(paths.agents, `${options.name}.md`);

  if (existsSync(agentPath)) {
    throw new Error(`Agent already exists: ${options.name}`);
  }

  // Read template
  const templatePath = join(paths.root, '.claude', 'agents', 'templates', 'agent-template.md');
  let template: string;

  if (existsSync(templatePath)) {
    template = readFileSync(templatePath, 'utf-8');
  } else {
    template = getDefaultTemplate();
  }

  // Fill in template
  const allowedTools = options.allowedTools && options.allowedTools.length > 0
    ? `[${options.allowedTools.join(', ')}]`
    : '[Read, Glob, Grep, Bash(kyberbot *)]';

  const content = template
    .replace(/\[agent-name\]/g, options.name)
    .replace(/\[Agent Name\]/g, formatAgentName(options.name))
    .replace(/\[One-line description.*?\]/g, options.description)
    .replace(/\[Role description.*?\]/g, options.role || `A specialized ${options.name} agent`)
    .replace(/model: sonnet/g, `model: ${options.model || 'opus'}`)
    .replace(/max-turns: 10/g, `max-turns: ${options.maxTurns || 10}`)
    .replace(/allowed-tools: \[Read, Glob, Grep, Bash\(kyberbot \*\)\]/g, `allowed-tools: ${allowedTools}`);

  writeFileSync(agentPath, content);

  logger.info(`Scaffolded agent: ${options.name}`, { path: agentPath });
  return agentPath;
}

function formatAgentName(name: string): string {
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getDefaultTemplate(): string {
  return `---
name: [agent-name]
description: "[One-line description]"
role: "[Role description]"
allowed-tools: [Read, Glob, Grep, Bash(kyberbot *)]
model: opus
max-turns: 10
---

# [Agent Name]

## Scope

You are a sub-agent delegated a specific task. Focus exclusively on the task given to you.

## How You Work

1. Analyze the prompt you've been given
2. Use your available tools to gather information
3. Produce a clear, structured response
4. Stay within your defined scope

## Output Format

Return your findings in a clear, structured format:
- Use headings for major sections
- Use bullet points for lists
- Include specific file paths, line numbers, or code snippets when relevant

## Constraints

- Do not modify files unless explicitly asked
- Do not take actions outside your delegated task
- If you cannot complete the task, explain what's blocking you
`;
}
