/**
 * /api/arp/notes.read — read one row by source_path scoped to project.
 * Mirrors the `notes.read collection_id=<project>` ARP scope.
 */

import type { Request, Response } from 'express';
import { getTimelineDb } from '../../brain/timeline.js';
import {
  applyRateLimit,
  applyResponseObligations,
  ObligationUnsatisfiable,
} from './obligations.js';
import type {
  NotesReadRequest,
  NotesReadResponse,
  NotesSearchResultItem,
  ArpErrorResponse,
} from './types.js';

export async function handleNotesRead(
  root: string,
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as Partial<NotesReadRequest>;
  if (!body.connection_id || typeof body.connection_id !== 'string') {
    return sendError(res, 400, { ok: false, error: 'bad_request', reason: 'connection_id required' });
  }
  if (!body.collection_id || typeof body.collection_id !== 'string') {
    return sendError(res, 400, { ok: false, error: 'bad_request', reason: 'collection_id required' });
  }
  if (!body.source_path || typeof body.source_path !== 'string') {
    return sendError(res, 400, { ok: false, error: 'bad_request', reason: 'source_path required' });
  }

  const rl = applyRateLimit({
    root,
    connectionId: body.connection_id,
    action: 'notes.read',
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

  // ── data layer query — ALWAYS scoped to project_id ───────────────
  // The peer's body has `collection_id`; the brain has `project_id`.
  // We trust neither in isolation: only return when the row's stored
  // project_id matches the claim. Out of scope ⇒ zero rows ⇒
  // not_found, regardless of whether the row would have been
  // returnable under a different scope.
  const db = await getTimelineDb(root);
  type Row = {
    id: number;
    content: string;
    source_path: string;
    timestamp: string;
    project_id: string;
    classification: string | null;
  };
  const row = db
    .prepare(
      `SELECT id, content, source_path, timestamp, project_id, classification
       FROM facts
       WHERE source_path = ?
         AND project_id = ?
         AND COALESCE(is_retracted, 0) = 0
         AND COALESCE(is_latest, 1) = 1
       LIMIT 1`,
    )
    .get(body.source_path, body.collection_id) as Row | undefined;

  if (!row) {
    return sendError(res, 404, {
      ok: false,
      error: 'not_found',
      reason: 'no row matches source_path within the requested collection_id',
      connection_id: body.connection_id,
    });
  }

  const item: NotesSearchResultItem = {
    id: String(row.id),
    content: row.content,
    source_path: row.source_path,
    timestamp: row.timestamp,
    project_id: row.project_id,
    ...(row.classification
      ? { classification: row.classification as 'public' | 'internal' | 'confidential' | 'pii' }
      : {}),
  };

  let result: NotesReadResponse = { ok: true, item, redactions_applied: false };
  try {
    const after = applyResponseObligations(
      result as unknown as Record<string, unknown>,
      body.obligations,
    );
    result = after.payload as unknown as NotesReadResponse;
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

function sendError(res: Response, status: number, body: ArpErrorResponse): void {
  res.status(status).json(body);
}
