/**
 * KyberBot — Telemetry Dashboard
 *
 * Local HTTP server that surfaces per-agent Claude subprocess usage from
 * Claude Code's session logs plus fleet-side activity from the bus /
 * sleep / heartbeat DBs. Designed to run alongside `kyberbot fleet start`
 * so a human can open a browser and see exactly which subprocess fired,
 * when, for which agent, and what it cost (at API-equivalent rates).
 *
 * Self-contained: the HTML + client JS is inlined below. No separate
 * bundle. Talks to Anthropic rates only for display — the subscription
 * is flat-rate, but API-equivalent cost is a useful relative meter.
 */

import { createServer, type Server } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../logger.js';
import { loadRegistry } from '../registry.js';
import type { ServiceHandle } from '../types.js';

const logger = createLogger('telemetry');

// Anthropic API rates per 1M tokens, April 2026. Cache-creation uses the
// 5-minute TTL rate (1.25× input). Source: platform.claude.com/docs/en/
// docs/about-claude/pricing.
const RATES: Record<string, { in: number; out: number; cr: number; cc: number }> = {
  opus:   { in: 5.00, out: 25.00, cr: 0.50, cc: 6.25 },   // Opus 4.7
  sonnet: { in: 3.00, out: 15.00, cr: 0.30, cc: 3.75 },   // Sonnet 4.6
  haiku:  { in: 1.00, out:  5.00, cr: 0.10, cc: 1.25 },   // Haiku 4.5
};

interface AgentProjectMap { name: string; root: string; projSlug: string }
interface UsageTotals { sessions: number; in: number; out: number; cr: number; cc: number }
interface ModelUsage { in: number; out: number; cr: number; cc: number }
interface SessionEvent {
  agent: string;
  file: string;
  endedAt: string;
  model: string | null;
  modelShort: string;
  in: number; out: number; cr: number; cc: number;
  cost: number;
  prompt: string;
}

function normalizeModel(m: string): string {
  const s = String(m).toLowerCase();
  if (s.includes('opus')) return 'opus';
  if (s.includes('sonnet')) return 'sonnet';
  if (s.includes('haiku')) return 'haiku';
  return s;
}

function estimateCostByModel(byModel: Record<string, ModelUsage>): number {
  let total = 0;
  for (const [name, v] of Object.entries(byModel)) {
    const r = RATES[name];
    if (!r) continue;
    total += (v.in * r.in + v.out * r.out + v.cr * r.cr + v.cc * r.cc) / 1_000_000;
  }
  return total;
}

function toSqlTs(iso: string): string {
  return iso.replace('T', ' ').replace(/Z$/, '');
}

function sqliteJson(dbPath: string, sql: string): Array<Record<string, unknown>> {
  if (!existsSync(dbPath)) return [];
  try {
    const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
    return out.trim() ? JSON.parse(out) : [];
  } catch {
    return [];
  }
}

function sqliteScalar(dbPath: string, sql: string): number {
  if (!existsSync(dbPath)) return 0;
  try {
    const out = execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf-8' });
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

function projectSlugFor(path: string): string {
  // Claude Code's project slug mirrors absolute path with "/" → "-".
  return path.replace(/^\//, '-').replace(/\//g, '-');
}

/**
 * Walk an agent's ~/.claude/projects/<slug>/ directory and sum usage
 * from every .jsonl file that was last touched since `sinceMs`.
 * Streams line-by-line to keep memory bounded; individual sessions
 * can be tens of MB.
 */
async function agentUsageSince(
  projDir: string,
  sinceMs: number,
  agentLabel: string,
): Promise<{ totals: UsageTotals; byModel: Record<string, ModelUsage>; events: SessionEvent[] }> {
  const totals: UsageTotals = { sessions: 0, in: 0, out: 0, cr: 0, cc: 0 };
  const byModel: Record<string, ModelUsage> = {};
  const events: SessionEvent[] = [];

  if (!existsSync(projDir)) return { totals, byModel, events };

  const files: string[] = [];
  const walk = (dir: string, depth = 0): void => {
    if (depth > 3) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(full);
    }
  };
  walk(projDir);

  for (const full of files) {
    let st;
    try { st = statSync(full); } catch { continue; }
    const lastActivityMs = Math.max(st.mtimeMs || 0, st.ctimeMs || 0);
    if (lastActivityMs < sinceMs) continue;
    totals.sessions++;

    const event: SessionEvent = {
      agent: agentLabel,
      file: full.slice(projDir.length + 1),
      endedAt: new Date(st.mtimeMs).toISOString(),
      model: null,
      modelShort: '',
      in: 0, out: 0, cr: 0, cc: 0,
      cost: 0,
      prompt: '',
    };

    try {
      const rl = createInterface({ input: createReadStream(full, { encoding: 'utf-8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        if (!event.prompt) {
          const role = obj?.message?.role || obj?.role;
          const content = obj?.message?.content ?? obj?.content;
          if (role === 'user' || obj?.type === 'queue-operation') {
            const text = typeof content === 'string'
              ? content
              : Array.isArray(content) ? content.map((c: any) => c.text || '').join(' ') : '';
            if (text) event.prompt = String(text).replace(/\s+/g, ' ').trim().slice(0, 200);
          }
        }

        const u = obj?.message?.usage || obj?.usage;
        if (!u) continue;
        const model = obj?.message?.model || obj?.model || 'unknown';
        if (!event.model) event.model = model;
        const inT = u.input_tokens || 0;
        const outT = u.output_tokens || 0;
        const crT = u.cache_read_input_tokens || 0;
        const ccT = u.cache_creation_input_tokens || 0;
        totals.in += inT; totals.out += outT; totals.cr += crT; totals.cc += ccT;
        event.in += inT; event.out += outT; event.cr += crT; event.cc += ccT;
        const key = normalizeModel(model);
        const m = (byModel[key] ||= { in: 0, out: 0, cr: 0, cc: 0 });
        m.in += inT; m.out += outT; m.cr += crT; m.cc += ccT;
      }
    } catch { /* skip unreadable */ }

    if (event.model || event.in || event.out || event.cr || event.cc) {
      const key = normalizeModel(event.model || '');
      event.modelShort = key;
      const r = RATES[key];
      event.cost = r ? (event.in * r.in + event.out * r.out + event.cr * r.cr + event.cc * r.cc) / 1_000_000 : 0;
      events.push(event);
    }
  }

  return { totals, byModel, events };
}

function resolveAgentProjectMap(): AgentProjectMap[] {
  try {
    const reg = loadRegistry();
    const out: AgentProjectMap[] = [];
    for (const [name, entry] of Object.entries(reg.agents)) {
      if (!entry || entry.type === 'remote' || !entry.root) continue;
      out.push({ name, root: entry.root, projSlug: projectSlugFor(entry.root) });
    }
    return out;
  } catch {
    return [];
  }
}

async function buildTelemetryPayload(stateDir: string): Promise<Record<string, unknown>> {
  const startIso = readStartTime(stateDir);
  const startMs = new Date(startIso).getTime();
  const startSql = toSqlTs(startIso);
  const now = new Date();

  const HOME = homedir();
  const PROJECTS = join(HOME, '.claude', 'projects');

  const agents = resolveAgentProjectMap();
  const agentResults: Array<Record<string, unknown>> = [];
  const totalsByModel: Record<string, ModelUsage> = {};
  const totals: UsageTotals = { sessions: 0, in: 0, out: 0, cr: 0, cc: 0 };
  const allEvents: SessionEvent[] = [];

  for (const a of agents) {
    const usage = await agentUsageSince(join(PROJECTS, a.projSlug), startMs, a.name);
    allEvents.push(...usage.events);
    const sleepCycles = sqliteScalar(join(a.root, 'data', 'sleep.db'),
      `SELECT count(*) FROM sleep_runs WHERE started_at > '${startSql}';`);
    agentResults.push({
      name: a.name,
      sessions: usage.totals.sessions,
      sleepCycles,
      totalIn: usage.totals.in,
      totalOut: usage.totals.out,
      totalCr: usage.totals.cr,
      totalCc: usage.totals.cc,
      byModel: usage.byModel,
      cost: estimateCostByModel(usage.byModel),
    });
    totals.sessions += usage.totals.sessions;
    totals.in += usage.totals.in;
    totals.out += usage.totals.out;
    totals.cr += usage.totals.cr;
    totals.cc += usage.totals.cc;
    for (const [k, v] of Object.entries(usage.byModel)) {
      const agg = (totalsByModel[k] ||= { in: 0, out: 0, cr: 0, cc: 0 });
      agg.in += v.in; agg.out += v.out; agg.cr += v.cr; agg.cc += v.cc;
    }
  }

  // Fleet-side bucket: Claude calls whose spawn CWD landed in a
  // monorepo/desktop project dir rather than an agent's dir (shouldn't
  // happen post-v1.8.8 but kept for visibility if something regresses).
  const EXTRA = ['-Users-ianborders-kyberbot-desktop'];
  try {
    const all = readdirSync(PROJECTS);
    for (const pname of all) {
      if (!EXTRA.some((p) => pname === p || pname.startsWith(p + '-'))) continue;
      const usage = await agentUsageSince(join(PROJECTS, pname), startMs, '(fleet-side)');
      if (!usage.totals.sessions && !usage.totals.in) continue;
      allEvents.push(...usage.events);
      agentResults.push({
        name: '(fleet-side)',
        sessions: usage.totals.sessions,
        sleepCycles: 0,
        totalIn: usage.totals.in,
        totalOut: usage.totals.out,
        totalCr: usage.totals.cr,
        totalCc: usage.totals.cc,
        byModel: usage.byModel,
        cost: estimateCostByModel(usage.byModel),
      });
      totals.sessions += usage.totals.sessions;
      totals.in += usage.totals.in;
      totals.out += usage.totals.out;
      totals.cr += usage.totals.cr;
      totals.cc += usage.totals.cc;
      for (const [k, v] of Object.entries(usage.byModel)) {
        const agg = (totalsByModel[k] ||= { in: 0, out: 0, cr: 0, cc: 0 });
        agg.in += v.in; agg.out += v.out; agg.cr += v.cr; agg.cc += v.cc;
      }
    }
  } catch { /* missing projects dir is fine */ }

  allEvents.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));

  // Fleet /health (live status)
  let fleet: unknown = null;
  try {
    const res = await fetch('http://localhost:3456/health', { signal: AbortSignal.timeout(2500) });
    if (res.ok) fleet = await res.json();
  } catch { /* fleet not up */ }

  // Bus + heartbeat event feed
  const heartbeatRuns = sqliteJson(join(HOME, '.kyberbot', 'orchestration.db'),
    `SELECT agent_name, type, status, started_at FROM heartbeat_runs WHERE started_at > '${startSql}' ORDER BY started_at DESC LIMIT 50;`);
  const busMessages = sqliteJson(join(HOME, '.kyberbot', 'bus.db'),
    `SELECT timestamp, from_agent, to_agent, type, topic, substr(payload, 1, 80) as payload FROM bus_messages WHERE timestamp > '${startIso}' ORDER BY timestamp DESC LIMIT 40;`);

  const liveEvents: Array<{ kind: string; ts: string; agent: string; detail: string }> = [];
  for (const h of heartbeatRuns) {
    liveEvents.push({
      kind: 'heartbeat',
      ts: String(h.started_at) + 'Z',
      agent: String(h.agent_name || ''),
      detail: `${h.type ?? '?'} · ${h.status ?? '?'}`,
    });
  }
  for (const a of agents) {
    const rows = sqliteJson(join(a.root, 'data', 'sleep.db'),
      `SELECT started_at, status FROM sleep_runs WHERE started_at > '${startSql}' ORDER BY started_at DESC LIMIT 10;`);
    for (const r of rows) {
      liveEvents.push({ kind: 'sleep', ts: String(r.started_at) + 'Z', agent: a.name, detail: String(r.status ?? '') });
    }
  }
  for (const b of busMessages) {
    liveEvents.push({
      kind: 'bus',
      ts: String(b.timestamp ?? ''),
      agent: String(b.from_agent ?? ''),
      detail: `→ ${b.to_agent} (${b.type})${b.topic ? ' #' + b.topic : ''}: ${b.payload ?? ''}`,
    });
  }
  liveEvents.sort((a, b) => (a.ts < b.ts ? 1 : -1));

  const costEstimates = {
    actual: estimateCostByModel(totalsByModel),
    opus: estimateCostByModel({ opus: { in: totals.in, out: totals.out, cr: totals.cr, cc: totals.cc } }),
    sonnet: estimateCostByModel({ sonnet: { in: totals.in, out: totals.out, cr: totals.cr, cc: totals.cc } }),
    haiku: estimateCostByModel({ haiku: { in: totals.in, out: totals.out, cr: totals.cr, cc: totals.cc } }),
  };

  return {
    start: startIso,
    now: now.toISOString(),
    windowMinutes: Math.max(0, (now.getTime() - startMs) / 60_000),
    fleet,
    agents: agentResults,
    totals: { ...totals, byModel: totalsByModel },
    costEstimates,
    recentSessions: allEvents.slice(0, 60),
    events: liveEvents.slice(0, 60),
  };
}

function readStartTime(stateDir: string): string {
  const p = join(stateDir, 'telemetry-start.txt');
  try {
    const iso = readFileSync(p, 'utf-8').trim();
    if (iso && !isNaN(new Date(iso).getTime())) return iso;
  } catch { /* default below */ }
  const iso = new Date().toISOString();
  try { writeFileSync(p, iso + '\n'); } catch { /* non-fatal */ }
  return iso;
}

function writeStartTime(stateDir: string, iso: string): void {
  const p = join(stateDir, 'telemetry-start.txt');
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(p, iso + '\n');
  } catch { /* non-fatal */ }
}

// ─── HTML (Orchestration-style dashboard) ───────────────────────────

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>KyberBot Telemetry</title>
<style>
  :root {
    /* Light theme only — matches the desktop app's light mode tokens.
       Warm cream background, slate-blue text, darker accent colors
       so teal and cyan stay readable on a bright surface. */
    --bg-primary: #faf9f7;
    --bg-secondary: #ffffff;
    --bg-tertiary: #f5f4f2;
    --bg-elevated: #ffffff;
    --fg-primary: #1e293b;
    --fg-secondary: #475569;
    --fg-tertiary: #64748b;
    --fg-muted: #94a3b8;
    --border-color: #e8e6e1;
    --border-color-hover: #d5d3ce;
    --accent-teal: #0d9488;
    --accent-cyan: #0891b2;
    --accent-violet: #7c3aed;
    --accent-emerald: #059669;
    --accent-amber: #d97706;
    --status-success: #059669;
    --status-warning: #d97706;
    --status-error: #dc2626;
    --status-info: #2563eb;
    --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.06);
    --shadow-md: 0 2px 6px rgba(0, 0, 0, 0.08);
    --font-mono: 'Space Mono', 'SF Mono', 'Monaco', 'Menlo', monospace;
    --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    /* Force light mode regardless of OS preference. Matches the
       telemetry design language — always light. */
    :root { color-scheme: light; }
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg-primary);
    color: var(--fg-primary);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.55;
    padding: 20px 24px 40px;
  }

  .section-title {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--accent-teal);
  }
  .label-sm {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 1.5px;
  }
  .mono { font-family: var(--font-mono); }
  .muted { color: var(--fg-muted); }
  .dim { color: var(--fg-tertiary); }

  /* ── Header ───────────────────────────────────────── */
  .hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 0 18px;
    border-bottom: 1px solid var(--border-color);
    margin-bottom: 20px;
  }
  .hdr h1 {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--accent-teal);
    margin: 0;
  }
  .hdr .meta {
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 10px;
    color: var(--fg-muted);
  }
  .hdr .meta .dot {
    display: inline-block; width: 6px; height: 6px; border-radius: 50%;
    margin-right: 6px; vertical-align: middle;
  }
  .hdr .meta .dot.ok { background: var(--status-success); box-shadow: 0 0 6px rgba(5,150,105,0.35); }
  .hdr .meta .dot.off { background: var(--status-error); box-shadow: 0 0 6px rgba(220,38,38,0.35); }

  /* ── Buttons ──────────────────────────────────────── */
  button {
    background: transparent;
    color: var(--fg-muted);
    border: 1px solid var(--border-color);
    padding: 6px 14px;
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    cursor: pointer;
    transition: color var(--tr, 100ms), border-color var(--tr, 100ms);
  }
  button:hover { color: var(--accent-teal); border-color: var(--accent-teal); }
  button.primary { background: var(--accent-teal); color: #fff; border-color: var(--accent-teal); }
  button.primary:hover { opacity: 0.85; }

  /* ── Stat cards (hero metrics) ────────────────────── */
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }
  .stat-card {
    padding: 16px;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 4px;
  }
  .stat-card .value {
    font-size: 30px;
    font-family: var(--font-mono);
    color: var(--accent-teal);
    font-weight: 500;
    line-height: 1;
  }
  .stat-card .value.lg { font-size: 26px; }
  .stat-card .label {
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 1.5px;
    margin-top: 8px;
  }

  /* ── Panels ───────────────────────────────────────── */
  .panel {
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    padding: 14px 16px;
    margin-bottom: 12px;
  }
  .panel .panel-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .panel .panel-hdr .count {
    font-size: 9px;
    color: var(--fg-muted);
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  .two-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 12px;
  }
  @media (max-width: 980px) { .two-col { grid-template-columns: 1fr; } }

  /* ── Tables (orchestration style) ─────────────────── */
  table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: 11px;
  }
  th {
    text-align: left;
    font-weight: 500;
    font-size: 9px;
    color: var(--fg-muted);
    letter-spacing: 1.5px;
    text-transform: uppercase;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border-color);
  }
  th.num, td.num { text-align: right; }
  td {
    padding: 7px 8px;
    border-bottom: 1px solid var(--border-color);
    color: var(--fg-secondary);
    vertical-align: top;
  }
  tr:last-child td { border-bottom: 0; }
  tr:hover td { background: rgba(13, 148, 136, 0.04); }

  /* Cost cell emphasis */
  td.cost { color: var(--accent-teal); font-weight: 500; text-align: right; }

  /* ── Badges (orchestration chips) ─────────────────── */
  .badge {
    display: inline-block;
    font-size: 9px;
    font-family: var(--font-mono);
    padding: 1px 6px;
    line-height: 14px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    background: rgba(0,0,0,0.04);
    color: var(--fg-tertiary);
    border: 1px solid var(--border-color);
  }
  .badge.haiku  { color: var(--accent-cyan);    border-color: rgba(8,145,178,0.3);   background: rgba(8,145,178,0.08); }
  .badge.sonnet { color: var(--accent-violet);  border-color: rgba(124,58,237,0.3);  background: rgba(124,58,237,0.08); }
  .badge.opus   { color: var(--accent-amber);   border-color: rgba(217,119,6,0.3);   background: rgba(217,119,6,0.08); }
  .badge.kind-heartbeat { color: var(--accent-cyan); border-color: rgba(8,145,178,0.3); background: rgba(8,145,178,0.08); }
  .badge.kind-sleep     { color: var(--accent-violet); border-color: rgba(124,58,237,0.3); background: rgba(124,58,237,0.08); }
  .badge.kind-bus       { color: var(--accent-emerald); border-color: rgba(5,150,105,0.3); background: rgba(5,150,105,0.08); }

  /* ── Row with status dot ──────────────────────────── */
  .dot-status {
    width: 6px; height: 6px; border-radius: 50%; display: inline-block;
    flex-shrink: 0; vertical-align: middle; margin-right: 8px;
  }
  .dot-status.running   { background: var(--status-success); box-shadow: 0 0 6px rgba(5,150,105,0.35); }
  .dot-status.stopped   { background: var(--fg-muted); }

  /* ── Prompt cell (truncate with hover tooltip) ────── */
  .prompt-cell {
    max-width: 440px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-muted);
    font-size: 10px;
  }

  /* ── Live events list ─────────────────────────────── */
  .events-list { list-style: none; padding: 0; margin: 0; max-height: 420px; overflow-y: auto; }
  .events-list li {
    padding: 6px 0;
    border-bottom: 1px solid var(--border-color);
    font-size: 10px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .events-list li:last-child { border-bottom: 0; }
  .events-list .ts { color: var(--fg-muted); width: 72px; flex-shrink: 0; }
  .events-list .ag { color: var(--fg-secondary); width: 90px; flex-shrink: 0; }
  .events-list .detail { color: var(--fg-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

  /* ── Empty state ──────────────────────────────────── */
  .empty {
    padding: 28px 16px;
    text-align: center;
    color: var(--fg-muted);
    font-size: 11px;
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 1.5px;
  }

  /* Scrollbar styling — subtle against the warm-cream background */
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: var(--bg-tertiary); }
  ::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 0; }
  ::-webkit-scrollbar-thumb:hover { background: var(--border-color-hover); }
</style>
</head>
<body>
  <div class="hdr">
    <h1>// TELEMETRY</h1>
    <div class="meta">
      <span id="fleetStatus">…</span>
      <span id="windowStr">…</span>
      <span id="lastUpdated">…</span>
      <button onclick="resetStart()">Reset window</button>
      <button class="primary" onclick="refresh()">Refresh</button>
    </div>
  </div>

  <div class="stat-grid" id="statGrid"></div>

  <div class="two-col">
    <div class="panel">
      <div class="panel-hdr">
        <span class="section-title">// PER MODEL</span>
        <span class="count" id="modelCount"></span>
      </div>
      <table id="modelTable">
        <thead>
          <tr>
            <th>Model</th>
            <th class="num">Input</th>
            <th class="num">Output</th>
            <th class="num">Cache R</th>
            <th class="num">Cache W</th>
            <th class="num">Cost</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="panel">
      <div class="panel-hdr">
        <span class="section-title">// COST SCENARIOS</span>
        <span class="count">api-equivalent</span>
      </div>
      <table id="costTable">
        <thead>
          <tr><th>Scenario</th><th class="num">Cost</th></tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <div class="panel-hdr">
      <span class="section-title">// PER AGENT</span>
      <span class="count" id="agentCount"></span>
    </div>
    <table id="agentTable">
      <thead>
        <tr>
          <th>Agent</th>
          <th class="num">Sessions</th>
          <th class="num">Sleep</th>
          <th class="num">Input</th>
          <th class="num">Output</th>
          <th class="num">Cache R</th>
          <th class="num">Cache W</th>
          <th class="num">Cost</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

  <div class="panel">
    <div class="panel-hdr">
      <span class="section-title">// RECENT SUBPROCESSES</span>
      <span class="count" id="sessCount"></span>
    </div>
    <table id="sessionTable">
      <thead>
        <tr>
          <th>Time</th>
          <th>Agent</th>
          <th>Model</th>
          <th class="num">Input</th>
          <th class="num">Output</th>
          <th class="num">Cache R</th>
          <th class="num">Cache W</th>
          <th class="num">Cost</th>
          <th>Prompt</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

  <div class="panel">
    <div class="panel-hdr">
      <span class="section-title">// LIVE ACTIVITY</span>
      <span class="count" id="evCount"></span>
    </div>
    <ul class="events-list" id="eventsList"></ul>
  </div>

<script>
const fmt = n => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const fmtUsd = n => (n == null ? '—' : '$' + Number(n).toFixed(4));
const fmtTime = iso => { try { return new Date(iso).toLocaleTimeString(); } catch { return '—'; } };

async function fetchTelemetry() {
  const r = await fetch('/api/telemetry');
  return r.json();
}

async function resetStart() {
  if (!confirm('Reset telemetry window start to now?')) return;
  await fetch('/api/reset', { method: 'POST' });
  refresh();
}

function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

function renderStats(t) {
  const grid = document.getElementById('statGrid');
  grid.innerHTML = '';
  const totalTok = (t.totals.in || 0) + (t.totals.out || 0) + (t.totals.cr || 0) + (t.totals.cc || 0);
  const cost = t.costEstimates.actual;
  const cards = [
    { label: 'Claude subprocesses', value: fmt(t.totals.sessions) },
    { label: 'Tokens (all buckets)', value: fmt(totalTok) },
    { label: 'API-equivalent cost', value: fmtUsd(cost) },
    { label: 'Window', value: t.windowMinutes.toFixed(0) + 'm' },
  ];
  for (const c of cards) {
    const el = document.createElement('div');
    el.className = 'stat-card';
    el.innerHTML = '<div class="value">' + c.value + '</div><div class="label">' + c.label + '</div>';
    grid.appendChild(el);
  }
}

function renderModels(t) {
  const tbody = document.querySelector('#modelTable tbody');
  tbody.innerHTML = '';
  const entries = Object.entries(t.totals.byModel || {});
  document.getElementById('modelCount').textContent = entries.length + ' models';
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No Claude calls in this window</td></tr>';
    return;
  }
  const RATES = { opus:{in:5,out:25,cr:.5,cc:6.25}, sonnet:{in:3,out:15,cr:.3,cc:3.75}, haiku:{in:1,out:5,cr:.1,cc:1.25} };
  entries.sort((a, b) => (b[1].cr + b[1].in + b[1].out + b[1].cc) - (a[1].cr + a[1].in + a[1].out + a[1].cc));
  for (const [name, v] of entries) {
    const r = RATES[name];
    const cost = r ? (v.in * r.in + v.out * r.out + v.cr * r.cr + v.cc * r.cc) / 1e6 : null;
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><span class="badge ' + name + '">' + name + '</span></td>' +
      '<td class="num">' + fmt(v.in) + '</td>' +
      '<td class="num">' + fmt(v.out) + '</td>' +
      '<td class="num">' + fmt(v.cr) + '</td>' +
      '<td class="num">' + fmt(v.cc) + '</td>' +
      '<td class="cost">' + fmtUsd(cost) + '</td>';
    tbody.appendChild(tr);
  }
}

function renderCostScenarios(t) {
  const tbody = document.querySelector('#costTable tbody');
  tbody.innerHTML = '';
  const rows = [
    ['Actual mix', t.costEstimates.actual],
    ['If all Haiku', t.costEstimates.haiku],
    ['If all Sonnet', t.costEstimates.sonnet],
    ['If all Opus', t.costEstimates.opus],
  ];
  for (const [label, v] of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + label + '</td><td class="cost">' + fmtUsd(v) + '</td>';
    tbody.appendChild(tr);
  }
}

function renderAgents(t) {
  const tbody = document.querySelector('#agentTable tbody');
  tbody.innerHTML = '';
  const agents = (t.agents || []).slice().sort((a, b) => (b.cost || 0) - (a.cost || 0));
  document.getElementById('agentCount').textContent = agents.length + ' agents';
  if (!agents.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">No agent activity yet</td></tr>';
    return;
  }
  for (const a of agents) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + a.name + '</td>' +
      '<td class="num">' + fmt(a.sessions) + '</td>' +
      '<td class="num">' + fmt(a.sleepCycles) + '</td>' +
      '<td class="num">' + fmt(a.totalIn) + '</td>' +
      '<td class="num">' + fmt(a.totalOut) + '</td>' +
      '<td class="num">' + fmt(a.totalCr) + '</td>' +
      '<td class="num">' + fmt(a.totalCc) + '</td>' +
      '<td class="cost">' + fmtUsd(a.cost) + '</td>';
    tbody.appendChild(tr);
  }
}

function renderSessions(t) {
  const tbody = document.querySelector('#sessionTable tbody');
  tbody.innerHTML = '';
  const sessions = t.recentSessions || [];
  document.getElementById('sessCount').textContent = sessions.length + ' shown · newest first';
  if (!sessions.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">No subprocess calls yet</td></tr>';
    return;
  }
  for (const s of sessions) {
    const promptEsc = String(s.prompt || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const model = s.modelShort || 'unknown';
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td class="dim">' + fmtTime(s.endedAt) + '</td>' +
      '<td>' + (s.agent || '—') + '</td>' +
      '<td><span class="badge ' + model + '">' + model + '</span></td>' +
      '<td class="num">' + fmt(s.in) + '</td>' +
      '<td class="num">' + fmt(s.out) + '</td>' +
      '<td class="num">' + fmt(s.cr) + '</td>' +
      '<td class="num">' + fmt(s.cc) + '</td>' +
      '<td class="cost">' + fmtUsd(s.cost) + '</td>' +
      '<td class="prompt-cell" title="' + promptEsc + '">' + promptEsc + '</td>';
    tbody.appendChild(tr);
  }
}

function renderEvents(t) {
  const list = document.getElementById('eventsList');
  list.innerHTML = '';
  const ev = t.events || [];
  document.getElementById('evCount').textContent = ev.length + ' shown';
  if (!ev.length) {
    list.innerHTML = '<li class="empty">No fleet events yet</li>';
    return;
  }
  for (const e of ev) {
    const li = document.createElement('li');
    const detailEsc = String(e.detail || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    li.innerHTML =
      '<span class="badge kind-' + e.kind + '">' + e.kind + '</span>' +
      '<span class="ts">' + fmtTime(e.ts) + '</span>' +
      '<span class="ag">' + (e.agent || '—') + '</span>' +
      '<span class="detail">' + detailEsc + '</span>';
    list.appendChild(li);
  }
}

async function refresh() {
  try {
    const t = await fetchTelemetry();

    // Fleet + window strings
    if (t.fleet) {
      const running = ((t.fleet.agents || []).filter(a => a.status === 'running')).length;
      const total = (t.fleet.agents || []).length;
      document.getElementById('fleetStatus').innerHTML =
        '<span class="dot ok"></span>fleet \u00b7 ' + running + '/' + total + ' running \u00b7 uptime ' + (t.fleet.uptime || '\u2014');
    } else {
      document.getElementById('fleetStatus').innerHTML = '<span class="dot off"></span>fleet not reachable';
    }
    setText('windowStr', 'window: ' + new Date(t.start).toLocaleTimeString() + ' → now · ' + t.windowMinutes.toFixed(1) + 'm');
    setText('lastUpdated', 'updated ' + new Date().toLocaleTimeString());

    renderStats(t);
    renderModels(t);
    renderCostScenarios(t);
    renderAgents(t);
    renderSessions(t);
    renderEvents(t);
  } catch (err) {
    setText('lastUpdated', 'refresh failed: ' + err);
  }
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

// ─── Server ─────────────────────────────────────────────────────────

export interface TelemetryOptions {
  /** Preferred port. If in use, the service walks up until it finds a free one. */
  port?: number;
  /** Where to persist telemetry-start.txt. Defaults to ~/.kyberbot */
  stateDir?: string;
}

/**
 * Start the telemetry dashboard HTTP server. Returns a ServiceHandle
 * suitable for registering with the fleet orchestrator.
 */
export async function startTelemetryServer(opts: TelemetryOptions = {}): Promise<ServiceHandle & { url: string }> {
  const preferredPort = opts.port ?? 4545;
  const stateDir = opts.stateDir ?? join(homedir(), '.kyberbot');
  try { mkdirSync(stateDir, { recursive: true }); } catch { /* non-fatal */ }

  const server: Server = createServer(async (req, res) => {
    try {
      const url = req.url || '/';
      if (url === '/' || url === '') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(HTML);
        return;
      }
      if (url === '/api/telemetry') {
        const data = await buildTelemetryPayload(stateDir);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }
      if (url === '/api/reset' && req.method === 'POST') {
        writeStartTime(stateDir, new Date().toISOString());
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String((err as Error)?.stack || err));
    }
  });

  // Walk up ports until we find a free one — don't conflict with an
  // already-running dashboard from a previous fleet launch.
  const chosen = await new Promise<number>((resolve, reject) => {
    let tries = 0;
    const tryListen = (p: number): void => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && tries++ < 10) {
          tryListen(p + 1);
        } else {
          reject(err);
        }
      });
      server.listen(p, '127.0.0.1', () => resolve(p));
    };
    tryListen(preferredPort);
  });

  const url = `http://localhost:${chosen}`;

  return {
    url,
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
    status: () => 'running' as const,
  };
}
