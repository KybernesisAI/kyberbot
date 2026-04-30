/**
 * Obligation enforcer — pure functions a typed ARP handler calls
 * before returning a response.
 *
 * The cloud-side connection token attaches `obligations` to every
 * decision (e.g., `redact_fields_except: { allowlist: [name, email] }`,
 * `rate_limit: { window: 'hour', max: 60 }`). Policy-at-the-wire
 * frameworks rely on the LLM to honor these via prompting; that's
 * lossy. The KyberBot/ARP integration applies them as code so
 * compliance is deterministic.
 *
 * Each function takes the response payload + the obligation list and
 * returns a (possibly modified) payload + a `redactions_applied` flag
 * for the audit trail. Functions that can't satisfy an obligation
 * (e.g., size-cap can't shrink an already-minimal payload) signal via
 * a thrown `ObligationUnsatisfiable` so the handler can return the
 * `obligation_unsatisfiable` error to the cloud — preferable to
 * silently leaking past the cap.
 */

import type { ArpObligation } from './types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export class ObligationUnsatisfiable extends Error {
  constructor(public obligationType: string, message: string) {
    super(`obligation ${obligationType} unsatisfiable: ${message}`);
    this.name = 'ObligationUnsatisfiable';
  }
}

/**
 * Apply every obligation to the given payload. Mutates a shallow copy
 * of `payload` (handlers should call this on the response object
 * before returning). Returns `{ payload, redacted }` where redacted is
 * true when any field was dropped/replaced.
 *
 * Rate-limit obligations are ENFORCED by `applyRateLimit` separately
 * (called early in the handler, before any work happens) since they
 * decide whether the call proceeds at all. The function below applies
 * post-work obligations (redact, max-size).
 */
export function applyResponseObligations<T extends Record<string, unknown>>(
  payload: T,
  obligations: ArpObligation[] | undefined,
): { payload: T; redacted: boolean } {
  if (!obligations || obligations.length === 0) {
    return { payload, redacted: false };
  }
  let working: T = { ...payload };
  let redacted = false;
  for (const ob of obligations) {
    switch (ob.type) {
      case 'redact_fields': {
        const fields = Array.isArray(ob.params['fields']) ? ob.params['fields'] as string[] : [];
        const before = JSON.stringify(working);
        working = stripFields(working, fields) as T;
        if (JSON.stringify(working) !== before) redacted = true;
        break;
      }
      case 'redact_fields_except': {
        const allowlistRaw = ob.params['allowlist'];
        const allowlist = parseAllowlist(allowlistRaw);
        if (!allowlist) {
          // Template wasn't substituted (still contains the {{...}}
          // placeholder). Treat as a hard fail rather than silently
          // returning everything.
          throw new ObligationUnsatisfiable(
            'redact_fields_except',
            `allowlist is not a usable list: ${JSON.stringify(allowlistRaw)}`,
          );
        }
        const before = JSON.stringify(working);
        working = keepOnlyFields(working, allowlist) as T;
        if (JSON.stringify(working) !== before) redacted = true;
        break;
      }
      case 'max_size_mb': {
        const max = typeof ob.params['max'] === 'number' ? (ob.params['max'] as number) : null;
        if (max !== null) {
          const size = JSON.stringify(working).length;
          if (size > max * 1_000_000) {
            throw new ObligationUnsatisfiable(
              'max_size_mb',
              `payload ${size} bytes exceeds cap ${max}MB; refusing to truncate silently`,
            );
          }
        }
        break;
      }
      case 'audit_level':
      case 'rate_limit':
        // Handled outside the response-payload pipeline.
        break;
      case 'summarize_only': {
        // Truncate `content` fields on items to at most max_words words
        // before they leave the agent. This is a coarse implementation —
        // the cedar intent is "give a summary, not raw content"; a true
        // LLM-driven summary lives in a future pass. Truncation
        // satisfies the no-leak invariant: the peer can't see beyond
        // the cap.
        const max = typeof ob.params['max_words'] === 'number'
          ? (ob.params['max_words'] as number)
          : null;
        if (max === null || max <= 0) break;
        const before = JSON.stringify(working);
        working = truncateContentWords(working, max) as T;
        if (JSON.stringify(working) !== before) redacted = true;
        break;
      }
      case 'require_principal_confirmation':
        // Out-of-band UX (a step-up prompt to the agent's principal).
        // Honoring this requires a UI hook KyberBot doesn't have yet;
        // fail loudly rather than ignore so the cloud sees the gap.
        throw new ObligationUnsatisfiable(
          'require_principal_confirmation',
          'KyberBot does not yet implement principal confirmation step-up',
        );
      default:
        // Unknown obligation — refuse rather than silently skip. The
        // caller can decide whether to relax (e.g., on dev installs).
        throw new ObligationUnsatisfiable(
          ob.type,
          `unknown obligation type: ${ob.type}`,
        );
    }
  }
  return { payload: working, redacted };
}

/**
 * Per-(connection_id, action) rate limiter. Backed by a tiny SQLite
 * file under <root>/data/arp-rate-limit.db so counts survive restarts.
 * Returns `{ allowed: true }` when the call may proceed, or
 * `{ allowed: false, retryAfterSec }` when the limit is hit.
 */
export function applyRateLimit(opts: {
  root: string;
  connectionId: string;
  action: string;
  obligations: ArpObligation[] | undefined;
  now?: () => Date;
}): { allowed: true } | { allowed: false; retryAfterSec: number; window: string; max: number } {
  const { obligations } = opts;
  const limitOb = obligations?.find((o) => o.type === 'rate_limit');
  if (!limitOb) return { allowed: true };
  const max = typeof limitOb.params['max'] === 'number' ? (limitOb.params['max'] as number) : null;
  const window = typeof limitOb.params['window'] === 'string' ? (limitOb.params['window'] as string) : null;
  if (max === null || window === null) return { allowed: true };
  const windowMs = parseWindow(window);
  if (windowMs === null) return { allowed: true }; // unknown window → fail-open

  const file = join(opts.root, 'data', 'arp-rate-limit.json');
  mkdirSync(dirname(file), { recursive: true });
  const now = opts.now ? opts.now().getTime() : Date.now();
  const key = `${opts.connectionId}::${opts.action}`;

  let state: Record<string, number[]> = {};
  if (existsSync(file)) {
    try {
      state = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, number[]>;
    } catch {
      state = {};
    }
  }
  const hits = (state[key] ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    const oldest = hits[0]!;
    const retryAfterSec = Math.ceil((windowMs - (now - oldest)) / 1000);
    return { allowed: false, retryAfterSec, window, max };
  }
  hits.push(now);
  state[key] = hits;
  writeFileSync(file, JSON.stringify(state), 'utf-8');
  return { allowed: true };
}

// ── helpers ───────────────────────────────────────────────────────────

/**
 * Walk the response payload and truncate any string-valued `content` field
 * to `maxWords` whitespace-delimited tokens. Items in `items[]` are walked
 * recursively. The truncation is a coarse stand-in for real summarisation
 * — sufficient to satisfy the obligation's no-leak invariant (peer can't
 * see beyond the cap) while a proper LLM-summary path is built.
 */
function truncateContentWords(obj: Record<string, unknown>, maxWords: number): Record<string, unknown> {
  function clipString(s: string): string {
    const tokens = s.split(/\s+/);
    if (tokens.length <= maxWords) return s;
    return tokens.slice(0, maxWords).join(' ') + '…';
  }
  function walk(value: unknown, key: string | null): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      return key === 'content' ? clipString(value) : value;
    }
    if (Array.isArray(value)) {
      return value.map((v) => walk(v, key));
    }
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v, k);
      }
      return out;
    }
    return value;
  }
  return walk(obj, null) as Record<string, unknown>;
}

function stripFields(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  // Supports dotted paths (`event.attendees`) for nested redaction.
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  for (const path of fields) {
    deletePath(out, path.split('.'));
  }
  return out;
}

function keepOnlyFields(obj: Record<string, unknown>, allowlist: string[]): Record<string, unknown> {
  // Top-level keep + recursive into arrays of objects (the common
  // search/result shape). Nested objects: only keep allowlisted leaves.
  // Dotted paths NOT supported here — allowlist is flat key names.
  const allow = new Set(allowlist);
  return walkAndKeep(obj, allow) as Record<string, unknown>;
}

function walkAndKeep(value: unknown, allow: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => walkAndKeep(v, allow));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (allow.has(k)) {
        out[k] = walkAndKeep(v, allow);
      }
    }
    return out;
  }
  return value;
}

function deletePath(obj: Record<string, unknown>, path: string[]): void {
  if (path.length === 0) return;
  if (path.length === 1) {
    delete obj[path[0]!];
    return;
  }
  const head = path[0]!;
  const rest = path.slice(1);
  const next = obj[head];
  if (next && typeof next === 'object' && !Array.isArray(next)) {
    deletePath(next as Record<string, unknown>, rest);
  }
}

/** Allowlist param may be an array, JSON-encoded array string, or a
 *  comma-separated string. Templates that didn't get substituted (still
 *  contain `{{…}}`) return null so the caller can surface the error. */
function parseAllowlist(raw: unknown): string[] | null {
  if (typeof raw === 'string') {
    if (raw.includes('{{')) return null;
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
      } catch {
        return null;
      }
    }
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string');
  }
  return null;
}

function parseWindow(spec: string): number | null {
  switch (spec) {
    case 'second':
      return 1000;
    case 'minute':
      return 60 * 1000;
    case 'hour':
      return 60 * 60 * 1000;
    case 'day':
      return 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}
