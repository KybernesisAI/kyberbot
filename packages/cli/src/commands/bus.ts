/**
 * Bus Command
 *
 * Inter-agent messaging via the fleet server's AgentBus API.
 *
 * Usage:
 *   kyberbot bus send <agent> "<message>"     # Send a message to a specific agent
 *   kyberbot bus broadcast "<message>"        # Broadcast to all agents
 *   kyberbot bus history                       # Show recent message history
 *   kyberbot bus history --agent nova          # Filter history by agent
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getServerPort, getAgentName as getConfigAgentName } from '../config.js';

const PRIMARY = chalk.hex('#10b981');
const ACCENT = chalk.hex('#22d3ee');
const DIM = chalk.dim;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function getFleetPort(): number {
  // Fleet manager always listens on 3456 in fleet mode (see registry.ts:168, fleet-manager.ts:110).
  // getServerPort() returns the per-agent port (e.g. 3457 for kermit, 3458 for rizzo) which is
  // wrong here — those ports require KYBERBOT_API_TOKEN auth and 401 the bus call, which then
  // falls back to a 404 "Not Found" via getFleetConnection().
  return 3456;
}

function getApiToken(): string {
  return process.env.KYBERBOT_API_TOKEN || '';
}

function getCurrentAgentName(): string {
  try {
    return getConfigAgentName();
  } catch {
    return 'unknown';
  }
}

async function fleetFetch(
  path: string,
  options: RequestInit = {},
  timeoutMs: number = 5000,
): Promise<Response> {
  const port = getFleetPort();
  const token = getApiToken();

  // Try local fleet first, then fall back to registered fleet connection (remote → local)
  let url = `http://localhost:${port}${path}`;
  let useToken = token;
  try {
    const { getFleetConnection } = await import('../server/bus-api.js');
    const conn = getFleetConnection();
    if (conn) {
      // We have a registered fleet connection — try it if local fails
      try {
        const localRes = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (!localRes.ok) throw new Error('local failed');
      } catch {
        url = `${conn.url}${path}`;
        useToken = conn.token || token;
      }
    }
  } catch { /* bus-api not loaded, use local */ }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (useToken) {
    headers['Authorization'] = `Bearer ${useToken}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND
// ═══════════════════════════════════════════════════════════════════════════════

export function createBusCommand(): Command {
  const bus = new Command('bus')
    .description('Inter-agent messaging via the fleet bus');

  // ─────────────────────────────────────────────────────────────
  // bus send <agent> <message>
  // ─────────────────────────────────────────────────────────────
  bus
    .command('send <agent> <message>')
    .description('Send a message to a specific agent')
    .option('-t, --topic <topic>', 'Message topic for routing')
    .option('-f, --from <name>', 'Sender name (defaults to current agent)')
    .option('--timeout <seconds>', 'How long to wait for the reply before giving up (default 600)', '600')
    .action(async (agent: string, message: string, options: { topic?: string; from?: string; timeout?: string }) => {
      const from = options.from || getCurrentAgentName();
      // Slow-thinking agents (big context, many tools, long memory files) can
      // legitimately take several minutes to produce a full reply. Default to
      // a generous 10 minutes and let the caller bump it explicitly if needed.
      // If this timeout fires, the target agent may still complete and write
      // its response to bus.db — check `kyberbot bus history` later.
      const timeoutMs = Math.max(1, parseInt(options.timeout || '600', 10)) * 1000;

      try {
        console.log(DIM(`Sending to ${agent}... (waiting for Claude response, up to ${timeoutMs / 1000}s)`));
        const res = await fleetFetch('/fleet/bus/send', {
          method: 'POST',
          body: JSON.stringify({
            from,
            to: agent,
            message,
            topic: options.topic,
          }),
        }, timeoutMs);

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
          console.error(chalk.red(`Error: ${body.error || res.statusText}`));
          process.exit(1);
        }

        const data = await res.json() as { ok: boolean; response: { payload: string } | null };

        console.log();
        console.log(PRIMARY.bold('  Message sent'));
        console.log();
        console.log(`  ${DIM('From:')}    ${ACCENT(from)}`);
        console.log(`  ${DIM('To:')}      ${ACCENT(agent)}`);
        if (options.topic) {
          console.log(`  ${DIM('Topic:')}   ${options.topic}`);
        }
        console.log(`  ${DIM('Message:')} ${message}`);

        if (data.response) {
          console.log();
          console.log(`  ${DIM('Response:')} ${data.response.payload}`);
        }
        console.log();
      } catch (error) {
        if ((error as Error).name === 'AbortError' || (error as Error).name === 'TimeoutError') {
          console.error(chalk.red(`Error: Timed out waiting for ${agent} to respond.`));
          console.error(DIM(`  The agent may still finish and write its reply to the bus.`));
          console.error(DIM(`  Check later: kyberbot bus history --agent ${agent}`));
          console.error(DIM(`  Or retry with a longer wait: kyberbot bus send ${agent} "..." --timeout 900`));
        } else {
          console.error(chalk.red(`Error: Could not reach fleet server. Is it running?`));
          console.error(DIM(`  Try: kyberbot fleet start`));
        }
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────
  // bus broadcast <message>
  // ─────────────────────────────────────────────────────────────
  bus
    .command('broadcast <message>')
    .description('Broadcast a message to all agents (optionally excluding some)')
    .option('-t, --topic <topic>', 'Message topic for routing')
    .option('-f, --from <name>', 'Sender name (defaults to current agent)')
    .option('--exclude <names>', 'Comma-separated list of agents to skip (the sender is always skipped)')
    .option('--timeout <seconds>', 'Per-agent wait for reply (default 600)', '600')
    .action(async (message: string, options: { topic?: string; from?: string; exclude?: string; timeout?: string }) => {
      const from = options.from || getCurrentAgentName();
      const excluded = new Set(
        (options.exclude || '')
          .split(',')
          .map((n) => n.trim().toLowerCase())
          .filter(Boolean),
      );
      excluded.add(from.toLowerCase()); // Don't send to yourself

      // Prefer the fleet server's live agent list — only agents actually
      // running are reachable. Fall back to the registry if the fleet server
      // isn't up (single-agent dev mode). Remote agents are skipped since
      // their reachability varies and bus-send already handles them.
      const targets: string[] = await (async () => {
        try {
          const res = await fetch('http://localhost:3456/health', { signal: AbortSignal.timeout(3000) });
          if (res.ok) {
            const body = await res.json() as { mode?: string; agents?: Array<{ name: string; status: string }> };
            if (body.mode === 'fleet' && Array.isArray(body.agents)) {
              return body.agents
                .filter((a) => a.status === 'running')
                .map((a) => a.name)
                .filter((n) => !excluded.has(n.toLowerCase()));
            }
          }
        } catch { /* fall through */ }
        try {
          const { loadRegistry } = await import('../registry.js');
          const reg = loadRegistry();
          return Object.keys(reg.agents).filter((n) => {
            if (excluded.has(n.toLowerCase())) return false;
            const entry = reg.agents[n];
            return !(entry?.type === 'remote');
          });
        } catch {
          return [];
        }
      })();

      if (targets.length === 0) {
        console.error(chalk.red('No target agents after exclusion.'));
        process.exit(1);
      }

      const timeoutMs = Math.max(1, parseInt(options.timeout || '600', 10)) * 1000;

      console.log();
      console.log(PRIMARY.bold(`  Broadcast to ${targets.length} agent${targets.length === 1 ? '' : 's'}`));
      console.log(`  ${DIM('From:')}     ${ACCENT(from)}`);
      console.log(`  ${DIM('Targets:')}  ${ACCENT(targets.join(', '))}`);
      if (excluded.size > 1) {
        console.log(`  ${DIM('Excluded:')} ${Array.from(excluded).filter((n) => n !== from.toLowerCase()).join(', ') || '(none)'}`);
      }
      if (options.topic) console.log(`  ${DIM('Topic:')}    ${options.topic}`);
      console.log(`  ${DIM('Message:')}  ${message}`);
      console.log();
      console.log(DIM(`  Waiting for replies (up to ${timeoutMs / 1000}s per agent)...`));
      console.log();

      // Fan out in parallel so slow agents don't block fast ones
      const results = await Promise.all(targets.map(async (agent) => {
        try {
          const res = await fleetFetch('/fleet/bus/send', {
            method: 'POST',
            body: JSON.stringify({ from, to: agent, message, topic: options.topic }),
          }, timeoutMs);
          if (!res.ok) {
            const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
            return { agent, ok: false as const, error: body.error || res.statusText };
          }
          const data = await res.json() as { ok: boolean; response: { payload: string } | null };
          return { agent, ok: true as const, response: data.response?.payload || '' };
        } catch (error) {
          const name = (error as Error).name;
          const errMsg = (name === 'AbortError' || name === 'TimeoutError') ? 'timed out' : String(error);
          return { agent, ok: false as const, error: errMsg };
        }
      }));

      let ok = 0;
      for (const r of results) {
        if (r.ok) {
          ok++;
          console.log(PRIMARY(`  ✓ ${r.agent}`));
          if (r.response) {
            const preview = r.response.length > 500 ? r.response.slice(0, 500) + '…' : r.response;
            for (const line of preview.split('\n')) console.log(`    ${DIM(line)}`);
          }
        } else {
          console.log(chalk.red(`  ✗ ${r.agent}: ${r.error}`));
          if (r.error === 'timed out') {
            console.log(DIM(`    (may still complete — check: kyberbot bus history --agent ${r.agent})`));
          }
        }
      }
      console.log();
      console.log(DIM(`  ${ok}/${targets.length} replied`));
      console.log();
      if (ok === 0) process.exit(1);
    });

  // ─────────────────────────────────────────────────────────────
  // bus history
  // ─────────────────────────────────────────────────────────────
  bus
    .command('history')
    .description('Show recent bus message history')
    .option('-a, --agent <name>', 'Filter by agent name')
    .option('-l, --limit <n>', 'Number of messages to show', '20')
    .action(async (options: { agent?: string; limit?: string }) => {
      const limit = parseInt(options.limit || '20') || 20;

      try {
        const params = new URLSearchParams({ limit: String(limit) });
        if (options.agent) {
          params.set('agent', options.agent);
        }

        const res = await fleetFetch(`/fleet/bus/history?${params.toString()}`);

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
          console.error(chalk.red(`Error: ${body.error || res.statusText}`));
          process.exit(1);
        }

        const data = await res.json() as {
          messages: Array<{
            id: string;
            from: string;
            to: string;
            type: string;
            topic?: string;
            payload: string;
            replyTo?: string;
            timestamp: string;
          }>;
        };

        console.log();
        if (data.messages.length === 0) {
          console.log(DIM('  No messages on the bus yet.'));
          console.log();
          return;
        }

        console.log(PRIMARY.bold('  Bus Message History'));
        if (options.agent) {
          console.log(DIM(`  Filtered by: ${options.agent}`));
        }
        console.log();

        for (const msg of data.messages) {
          const time = new Date(msg.timestamp).toLocaleTimeString();
          const direction = msg.to === '*' ? 'broadcast' : `-> ${msg.to}`;
          const typeLabel = msg.type === 'response' ? chalk.gray('[reply]') : '';
          const topicLabel = msg.topic ? chalk.gray(` [${msg.topic}]`) : '';

          console.log(
            `  ${DIM(time)} ${ACCENT(msg.from)} ${direction}${topicLabel} ${typeLabel}`
          );
          console.log(`    ${msg.payload.slice(0, 120)}${msg.payload.length > 120 ? '...' : ''}`);
          console.log();
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          console.error(chalk.red('Error: Fleet server not responding (timeout)'));
        } else {
          console.error(chalk.red(`Error: Could not reach fleet server. Is it running?`));
          console.error(DIM(`  Try: kyberbot fleet start`));
        }
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────
  // bus subscribe <from> <topic>
  // ─────────────────────────────────────────────────────────────
  bus
    .command('subscribe')
    .description('Subscribe to messages from an agent on a topic')
    .argument('<from>', 'Agent name to subscribe to (or "*" for all)')
    .argument('<topic>', 'Topic to subscribe to')
    .action(async (from: string, topic: string) => {
      // Update identity.yaml
      try {
        const { getRoot } = await import('../config.js');
        const { readFileSync, writeFileSync } = await import('fs');
        const { join } = await import('path');
        const yaml = (await import('js-yaml')).default;

        const root = getRoot();
        const identityPath = join(root, 'identity.yaml');
        const identity = yaml.load(readFileSync(identityPath, 'utf-8')) as Record<string, unknown>;

        if (!identity.subscriptions) identity.subscriptions = [];
        const subs = identity.subscriptions as Array<{ from: string; topic: string }>;

        // Check for duplicate
        if (subs.some(s => s.from === from && s.topic === topic)) {
          console.log(DIM(`Already subscribed to ${topic} from ${from}`));
          return;
        }

        subs.push({ from, topic });
        writeFileSync(identityPath, yaml.dump(identity, { lineWidth: 120 }), 'utf-8');
        console.log(PRIMARY(`Subscribed to "${topic}" from ${from}`));
        console.log(DIM('Takes effect on next agent start or fleet restart'));
      } catch (error) {
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────
  // bus unsubscribe <from> <topic>
  // ─────────────────────────────────────────────────────────────
  bus
    .command('unsubscribe')
    .description('Remove a topic subscription')
    .argument('<from>', 'Agent name')
    .argument('<topic>', 'Topic')
    .action(async (from: string, topic: string) => {
      try {
        const { getRoot } = await import('../config.js');
        const { readFileSync, writeFileSync } = await import('fs');
        const { join } = await import('path');
        const yaml = (await import('js-yaml')).default;

        const root = getRoot();
        const identityPath = join(root, 'identity.yaml');
        const identity = yaml.load(readFileSync(identityPath, 'utf-8')) as Record<string, unknown>;

        if (!identity.subscriptions) {
          console.log(DIM('No subscriptions found'));
          return;
        }

        const subs = identity.subscriptions as Array<{ from: string; topic: string }>;
        identity.subscriptions = subs.filter(s => !(s.from === from && s.topic === topic));
        writeFileSync(identityPath, yaml.dump(identity, { lineWidth: 120 }), 'utf-8');
        console.log(PRIMARY(`Unsubscribed from "${topic}" from ${from}`));
      } catch (error) {
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────
  // bus subscriptions
  // ─────────────────────────────────────────────────────────────
  bus
    .command('subscriptions')
    .description('List active topic subscriptions')
    .action(async () => {
      try {
        const { getRoot } = await import('../config.js');
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        const yaml = (await import('js-yaml')).default;

        const root = getRoot();
        const identityPath = join(root, 'identity.yaml');
        const identity = yaml.load(readFileSync(identityPath, 'utf-8')) as Record<string, unknown>;
        const subs = (identity.subscriptions || []) as Array<{ from: string; topic: string }>;

        if (subs.length === 0) {
          console.log(DIM('No subscriptions configured'));
          return;
        }

        console.log();
        console.log(PRIMARY.bold('  Topic Subscriptions'));
        console.log();
        for (const sub of subs) {
          console.log(`  ${ACCENT(sub.from)} → ${sub.topic}`);
        }
        console.log();
      } catch (error) {
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  return bus;
}
