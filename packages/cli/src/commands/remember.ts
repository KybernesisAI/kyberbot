/**
 * Remember Command
 *
 * Stores a conversation or piece of information in the memory pipeline.
 * Calls storeConversation() — the same orchestrator used by Telegram,
 * WhatsApp, and heartbeat — so terminal sessions get full entity graph,
 * timeline, and embedding support.
 *
 * Usage:
 *   kyberbot remember "Met with Sarah from Notion about the API integration"
 *   kyberbot remember "Decided to use PostgreSQL for the new project" --response "Based on scalability needs"
 *   kyberbot remember "Quick sync with the team" --channel slack
 */

import { Command } from 'commander';
import { storeConversation } from '../brain/store-conversation.js';
import { getRoot } from '../config.js';

async function handleRemember(
  text: string,
  options: { response?: string; channel?: string }
) {
  try {
    const root = getRoot();
    const channel = options.channel || 'terminal';
    const response = options.response || '';

    await storeConversation(root, {
      prompt: text,
      response,
      channel,
    });

    console.log(`Stored in memory (channel: ${channel})`);
    console.log(`  Text: ${text.length > 80 ? text.slice(0, 77) + '...' : text}`);
    if (response) {
      console.log(`  Response: ${response.length > 80 ? response.slice(0, 77) + '...' : response}`);
    }
  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}

export function createRememberCommand(): Command {
  return new Command('remember')
    .description('Store a memory in the brain (timeline, entity graph, embeddings)')
    .argument('<text>', 'The text to remember (conversation prompt or note)')
    .option('-r, --response <text>', 'Optional response/context to pair with the prompt')
    .option('-c, --channel <name>', 'Channel label (default: terminal)', 'terminal')
    .action(handleRemember);
}
