/**
 * Kybernesis Command
 *
 * Cloud brain interface — search and manage workspace memories via MCP.
 * The API key is tied to a workspace; no agent_id needed.
 *
 * Usage:
 *   kyberbot kybernesis query "What do you know about X?"
 *   kyberbot kybernesis status
 */

import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { createLogger } from '../logger.js';

const logger = createLogger('kybernesis');

const KYBERNESIS_MCP_URL = 'https://api.kybernesis.ai/mcp';

// ═══════════════════════════════════════════════════════════════════════════════
// API CLIENT (MCP over HTTP)
// ═══════════════════════════════════════════════════════════════════════════════

interface MCPResponse {
  result?: {
    content?: Array<{ type: string; text: string }>;
  };
  error?: { code: number; message: string };
  jsonrpc: string;
  id: number;
}

function getApiKey(): string | null {
  return process.env.KYBERNESIS_API_KEY || null;
}

async function callMCPTool(apiKey: string, toolName: string, args: Record<string, unknown>): Promise<string | null> {
  const response = await fetch(KYBERNESIS_MCP_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: toolName, arguments: args },
      id: Date.now(),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Kybernesis MCP error (${response.status}): ${text}`);
  }

  const text = await response.text();

  // Parse SSE response (format: "event: message\ndata: {...}")
  const dataMatch = text.match(/data:\s*(\{[\s\S]*\})/);
  if (!dataMatch) {
    // Try parsing as plain JSON
    try {
      const data = JSON.parse(text) as MCPResponse;
      if (data.error) throw new Error(data.error.message);
      return data.result?.content?.[0]?.text || null;
    } catch {
      throw new Error('Could not parse Kybernesis response');
    }
  }

  const data = JSON.parse(dataMatch[1]) as MCPResponse;
  if (data.error) throw new Error(data.error.message);
  return data.result?.content?.[0]?.text || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleQuery(message: string, opts: { limit?: string }) {
  const apiKey = requireApiKey();
  const limit = opts.limit ? parseInt(opts.limit, 10) : 50;

  try {
    logger.debug(`Searching Kybernesis workspace memory (limit: ${limit})`);
    const result = await callMCPTool(apiKey, 'kybernesis_search_memory', {
      query: message,
      limit,
    });

    if (result) {
      console.log(result);
    } else {
      console.log('No results found.');
    }
  } catch (error) {
    console.error(`Error querying Kybernesis: ${error}`);
    process.exit(1);
  }
}

async function handleList(opts: { limit?: string; offset?: string }) {
  const apiKey = requireApiKey();
  const limit = opts.limit ? parseInt(opts.limit, 10) : 50;
  const offset = opts.offset ? parseInt(opts.offset, 10) : 0;

  try {
    logger.debug(`Listing Kybernesis memories (limit: ${limit}, offset: ${offset})`);
    const result = await callMCPTool(apiKey, 'kybernesis_list_memories', {
      limit,
      offset,
    });

    if (result) {
      console.log(result);
    } else {
      console.log('No memories found.');
    }
  } catch (error) {
    console.error(`Error listing Kybernesis memories: ${error}`);
    process.exit(1);
  }
}

function requireApiKey(): string {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log('Kybernesis is not configured.');
    console.log('');
    console.log('Add KYBERNESIS_API_KEY to .env:');
    console.log('  1. Sign up at https://kybernesis.ai');
    console.log('  2. Go to Settings > API Keys');
    console.log('  3. Create a key and add it to .env');
    console.log('');
    console.log('Or run `kyberbot onboard` to set up interactively.');
    process.exit(1);
  }
  return apiKey;
}

async function handleStatus() {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log('Kybernesis: not configured');
    console.log('');
    console.log('Add KYBERNESIS_API_KEY to .env to enable cloud memory.');
    return;
  }

  console.log('Kybernesis: configured');
  console.log(`  API key: ${apiKey.slice(0, 8)}...`);

  // Test connectivity with a simple search
  try {
    await callMCPTool(apiKey, 'kybernesis_search_memory', {
      query: 'test',
      limit: 1,
    });
    console.log('  Status: connected');
  } catch (error) {
    console.log(`  Status: error (${error})`);
  }
}

async function handleDisconnect() {
  const envRoot = process.env.KYBERBOT_ROOT || process.cwd();
  const envPath = join(envRoot, '.env');

  if (!existsSync(envPath)) {
    console.log('No .env file found — Kybernesis is not configured.');
    return;
  }

  const envContent = readFileSync(envPath, 'utf-8');

  if (!envContent.includes('KYBERNESIS_API_KEY')) {
    console.log('Kybernesis is not configured (no KYBERNESIS_API_KEY in .env).');
    return;
  }

  // Remove the KYBERNESIS_API_KEY line
  const updated = envContent
    .split('\n')
    .filter(line => !line.startsWith('KYBERNESIS_API_KEY='))
    .join('\n');

  writeFileSync(envPath, updated);

  console.log(chalk.green('Kybernesis disconnected.'));
  console.log('');
  console.log('Your cloud memories are still in Kybernesis — nothing was deleted.');
  console.log('The agent will use local-only memory from now on.');
  console.log('');
  console.log(chalk.bold('To finish:'));
  console.log('  1. Restart the server:   kyberbot');
  console.log('  2. Restart Claude:       /clear or start a new session');
  console.log('');
  console.log(chalk.dim('To reconnect later: add KYBERNESIS_API_KEY back to .env'));
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

export function createKybernesisCommand(): Command {
  const cmd = new Command('kybernesis')
    .description('Kybernesis cloud brain — search and manage workspace memory');

  cmd
    .command('query')
    .description('Search the cloud brain')
    .argument('<message>', 'Search query for workspace memory')
    .option('-l, --limit <n>', 'Max results (default: 50)')
    .action(handleQuery);

  cmd
    .command('list')
    .description('List all memories in the cloud brain')
    .option('-l, --limit <n>', 'Max results (default: 50)')
    .option('-o, --offset <n>', 'Skip first N results (default: 0)')
    .action(handleList);

  cmd
    .command('status')
    .description('Check Kybernesis connection status')
    .action(handleStatus);

  cmd
    .command('disconnect')
    .description('Remove Kybernesis API key and switch to local-only memory')
    .action(handleDisconnect);

  return cmd;
}
