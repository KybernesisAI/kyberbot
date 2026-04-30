/**
 * Remember Command
 *
 * Stores a conversation or piece of information in the memory pipeline.
 *
 * Strategy:
 * 1. Try the running server's /remember API (lightweight HTTP POST — no
 *    heavy modules loaded, reuses the server's already-initialized
 *    ChromaDB/OpenAI/entity-graph connections)
 * 2. Fall back to direct storeConversation() if server isn't available
 *
 * This prevents OOM crashes when `kyberbot remember` is called as a
 * Bash tool from Claude Code, which would otherwise spawn a second
 * full kyberbot process loading the entire memory pipeline again.
 *
 * ARP unification (Phase A.6): the --project / --tag / --classification
 * flags stamp memories with @kybernesis/arp-spec :: AgentResourceMetadata
 * fields so typed /api/arp/* handlers (Phase B) can later filter by them.
 * `kyberbot remember "fact" --project alpha` and `arpc send peer "ask Atlas
 * about alpha"` use the SAME project_id vocabulary. No translation layer.
 */

import { Command } from 'commander';
import { getRoot, getServerPort } from '../config.js';

interface RememberOptions {
  response?: string;
  channel?: string;
  // ── ARP unification (Phase A.6) — agent-resource metadata flags ──
  // All optional. When set, these flow through input.metadata into
  // storeConversation() and stamp the new columns on facts /
  // timeline / sessions / ChromaDB metadata.
  project?: string;
  tag?: string[];
  classification?: 'public' | 'internal' | 'confidential' | 'pii';
  connection?: string;
  sourceDid?: string;
}

async function handleRemember(text: string, options: RememberOptions) {
  const channel = options.channel || 'terminal';
  const response = options.response || '';

  const arpMetadata = buildArpMetadata(options);

  // Try the running server's API first (avoids loading heavy modules)
  if (await tryServerRemember(text, response, channel, arpMetadata)) {
    console.log(`Stored in memory (channel: ${channel}${describeArp(arpMetadata)})`);
    console.log(`  Text: ${text.length > 80 ? text.slice(0, 77) + '...' : text}`);
    return;
  }

  // Fall back to direct storage (loads full pipeline — last resort)
  try {
    const root = getRoot();
    const { storeConversation } = await import('../brain/store-conversation.js');

    await storeConversation(root, {
      prompt: text,
      response,
      channel,
      ...(arpMetadata ? { metadata: arpMetadata } : {}),
    });

    console.log(`Stored in memory (channel: ${channel}${describeArp(arpMetadata)})`);
    console.log(`  Text: ${text.length > 80 ? text.slice(0, 77) + '...' : text}`);
  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}

function buildArpMetadata(opts: RememberOptions): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (opts.project) out['project_id'] = opts.project;
  if (opts.tag && opts.tag.length > 0) out['tags'] = opts.tag;
  if (opts.classification) out['classification'] = opts.classification;
  if (opts.connection) out['connection_id'] = opts.connection;
  if (opts.sourceDid) out['source_did'] = opts.sourceDid;
  return Object.keys(out).length > 0 ? out : null;
}

function describeArp(meta: Record<string, unknown> | null): string {
  if (!meta) return '';
  const parts: string[] = [];
  if (meta['project_id']) parts.push(`project=${meta['project_id']}`);
  if (Array.isArray(meta['tags']) && meta['tags'].length > 0) {
    parts.push(`tags=${(meta['tags'] as string[]).join(',')}`);
  }
  if (meta['classification']) parts.push(`class=${meta['classification']}`);
  return parts.length > 0 ? `, ${parts.join(', ')}` : '';
}

/**
 * Try to store via the running server's /remember endpoint.
 * This reuses the server's already-initialized memory pipeline
 * (ChromaDB client, OpenAI client, SQLite connections) instead of
 * loading everything from scratch in a new process.
 */
async function tryServerRemember(
  text: string,
  response: string,
  channel: string,
  arpMetadata: Record<string, unknown> | null
): Promise<boolean> {
  try {
    const port = getServerPort();
    const token = process.env.KYBERBOT_API_TOKEN;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`http://localhost:${port}/api/web/manage/remember`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text,
        response,
        channel,
        ...(arpMetadata ? { metadata: arpMetadata } : {}),
      }),
      signal: AbortSignal.timeout(30_000), // 30s timeout for heavy operations
    });

    if (res.ok) return true;

    // Server returned an error — fall through to direct storage
    return false;
  } catch {
    // Server not running or unreachable — fall through
    return false;
  }
}

export function createRememberCommand(): Command {
  return new Command('remember')
    .description('Store a memory in the brain (timeline, entity graph, embeddings)')
    .argument('<text>', 'The text to remember (conversation prompt or note)')
    .option('-r, --response <text>', 'Optional response/context to pair with the prompt')
    .option('-c, --channel <name>', 'Channel label (default: terminal)', 'terminal')
    // ── ARP unification (Phase A.6) — agent-resource metadata flags ──
    .option('--project <id>', 'Project the memory belongs to (matches the ProjectID parameter in ARP scope policies)')
    .option('--tag <name>', 'Tag the memory (repeatable, e.g. --tag launch --tag draft)', collectTag, [] as string[])
    .option('--classification <tier>', 'Sensitivity: public | internal | confidential | pii', validateClassification)
    .option('--connection <id>', 'ARP connection_id this memory belongs to (rare — usually stamped automatically by the bridge)')
    .option('--source-did <did>', 'Originating agent DID (rare — usually stamped automatically)')
    .action(handleRemember);
}

function collectTag(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function validateClassification(value: string): 'public' | 'internal' | 'confidential' | 'pii' {
  if (!['public', 'internal', 'confidential', 'pii'].includes(value)) {
    throw new Error(`--classification must be one of: public | internal | confidential | pii`);
  }
  return value as 'public' | 'internal' | 'confidential' | 'pii';
}
