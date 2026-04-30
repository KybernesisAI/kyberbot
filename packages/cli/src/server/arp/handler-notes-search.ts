/**
 * /api/arp/notes.search — typed handler for the
 * `notes.search collection_id=<project>` ARP scope.
 *
 * Returns conversation-class chunks scoped to `project_id =
 * collection_id` (the cedar policy template renders
 * `resource == NotesCollection::"<id>"` and the brain stores
 * project_id on each row; using the SAME id keeps the picker, wire,
 * and data layer aligned). Falls back to FTS over facts when
 * ChromaDB is unavailable.
 */

import type { Request, Response } from 'express';
import { semanticSearch } from '../../brain/embeddings.js';
import { getTimelineDb } from '../../brain/timeline.js';
import {
  applyRateLimit,
  applyResponseObligations,
  ObligationUnsatisfiable,
} from './obligations.js';
import type {
  NotesSearchRequest,
  NotesSearchResponse,
  NotesSearchResultItem,
  ArpErrorResponse,
} from './types.js';

export async function handleNotesSearch(
  root: string,
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as Partial<NotesSearchRequest>;

  // ── input validation ─────────────────────────────────────────────
  if (!body.connection_id || typeof body.connection_id !== 'string') {
    return sendError(res, 400, { ok: false, error: 'bad_request', reason: 'connection_id required' });
  }
  if (!body.collection_id || typeof body.collection_id !== 'string') {
    return sendError(res, 400, { ok: false, error: 'bad_request', reason: 'collection_id required' });
  }
  if (!body.query || typeof body.query !== 'string') {
    return sendError(res, 400, { ok: false, error: 'bad_request', reason: 'query required' });
  }
  const limit = Math.min(Math.max(body.limit ?? 10, 1), 50);

  // ── rate limit (pre-work) ────────────────────────────────────────
  const rl = applyRateLimit({
    root,
    connectionId: body.connection_id,
    action: 'notes.search',
    obligations: body.obligations,
  });
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfterSec));
    return sendError(res, 429, {
      ok: false,
      error: 'rate_limited',
      reason: `${rl.max}/${rl.window} cap; retry in ${rl.retryAfterSec}s`,
      connection_id: body.connection_id,
    });
  }

  // ── search (semantic when available, FTS otherwise) ──────────────
  const projectId = body.collection_id;
  let items: NotesSearchResultItem[] = [];
  try {
    const semantic = await semanticSearch(root, body.query, {
      limit,
      project_id: projectId,
    });
    items = semantic.map((r) => ({
      id: r.id,
      content: r.content,
      source_path: r.metadata.source_path,
      timestamp: r.metadata.timestamp,
      project_id: r.metadata.project_id ?? projectId,
      ...(r.metadata.classification ? { classification: r.metadata.classification } : {}),
    }));
  } catch (err) {
    // Semantic search is best-effort; fall through to FTS.
    void err;
  }

  if (items.length === 0) {
    items = await ftsFactsScoped(root, projectId, body.query, body.tags, limit);
  }

  // ── apply obligations ────────────────────────────────────────────
  let result: NotesSearchResponse = {
    ok: true,
    items,
    redactions_applied: false,
  };
  try {
    const after = applyResponseObligations(
      result as unknown as Record<string, unknown>,
      body.obligations,
    );
    result = after.payload as unknown as NotesSearchResponse;
    result.redactions_applied = after.redacted;
  } catch (err) {
    if (err instanceof ObligationUnsatisfiable) {
      return sendError(res, 422, {
        ok: false,
        error: 'obligation_unsatisfiable',
        reason: err.message,
        connection_id: body.connection_id,
      });
    }
    throw err;
  }

  res.json(result);
}

async function ftsFactsScoped(
  root: string,
  projectId: string,
  query: string,
  tags: string[] | undefined,
  limit: number,
): Promise<NotesSearchResultItem[]> {
  const db = await getTimelineDb(root);
  // Use the existing facts_fts virtual table. Filter by project_id
  // AND optionally tag substring (`tags_json` is a JSON array stored
  // as text; cheap LIKE for now, can move to JSON-aware queries later).
  let sql = `
    SELECT facts.id, facts.content, facts.source_path, facts.timestamp,
           facts.project_id, facts.classification, facts.tags_json
    FROM facts_fts
    JOIN facts ON facts.id = facts_fts.rowid
    WHERE facts_fts MATCH ?
      AND facts.project_id = ?
      AND COALESCE(facts.is_retracted, 0) = 0
      AND COALESCE(facts.is_latest, 1) = 1
  `;
  const params: unknown[] = [query, projectId];
  if (tags && tags.length > 0) {
    const tagClauses = tags.map(() => `facts.tags_json LIKE ?`).join(' OR ');
    sql += ` AND (${tagClauses})`;
    for (const tag of tags) params.push(`%${tag}%`);
  }
  sql += ` ORDER BY facts.timestamp DESC LIMIT ?`;
  params.push(limit);

  type Row = {
    id: number;
    content: string;
    source_path: string;
    timestamp: string;
    project_id: string;
    classification: string | null;
    tags_json: string | null;
  };
  const rows = db.prepare(sql).all(...params) as Row[];
  return rows.map((r) => ({
    id: String(r.id),
    content: r.content,
    source_path: r.source_path,
    timestamp: r.timestamp,
    project_id: r.project_id,
    ...(r.classification
      ? { classification: r.classification as 'public' | 'internal' | 'confidential' | 'pii' }
      : {}),
  }));
}

function sendError(res: Response, status: number, body: ArpErrorResponse): void {
  res.status(status).json(body);
}
