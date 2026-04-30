/**
 * /api/arp/knowledge.query — semantic search over a knowledge base
 * (mapped 1:1 to project_id) with token-bounded answer.
 *
 * Mirrors the ARP `knowledge.query kb_id=<project> max_tokens=<N>`
 * scope. The handler:
 *   1. Rate-limits by (connection_id, action).
 *   2. Runs ChromaDB semanticSearch scoped by project_id.
 *   3. Concatenates source chunk text up to max_tokens (rough char
 *      cap; Claude tokens are ~4 chars/tok in English so we use
 *      max_tokens * 4 as the byte cap).
 *   4. Returns the assembled answer + the source chunks (so the
 *      caller can verify what produced the answer).
 *   5. Applies obligations to the response.
 *
 * NOT an LLM-synthesized answer — that's a Phase B+ enhancement
 * (would call into the kyberbot brain's RAG path). For now the
 * "answer" is the concatenated chunk text; honest enough to start.
 */

import type { Request, Response } from 'express';
import { semanticSearch } from '../../brain/embeddings.js';
import {
  applyRateLimit,
  applyResponseObligations,
  ObligationUnsatisfiable,
} from './obligations.js';
import type {
  KnowledgeQueryRequest,
  KnowledgeQueryResponse,
  ArpErrorResponse,
} from './types.js';

const ROUGH_CHARS_PER_TOKEN = 4;

export async function handleKnowledgeQuery(
  root: string,
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as Partial<KnowledgeQueryRequest>;
  if (!body.connection_id || typeof body.connection_id !== 'string') {
    return sendError(res, 400, { ok: false, error: 'bad_request', reason: 'connection_id required' });
  }
  if (!body.kb_id || typeof body.kb_id !== 'string') {
    return sendError(res, 400, { ok: false, error: 'bad_request', reason: 'kb_id required' });
  }
  if (!body.query || typeof body.query !== 'string') {
    return sendError(res, 400, { ok: false, error: 'bad_request', reason: 'query required' });
  }
  const maxTokens = Math.min(Math.max(body.max_tokens ?? 4000, 100), 16000);
  const charCap = maxTokens * ROUGH_CHARS_PER_TOKEN;

  const rl = applyRateLimit({
    root,
    connectionId: body.connection_id,
    action: 'knowledge.query',
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

  const hits = await semanticSearch(root, body.query, {
    limit: 10,
    project_id: body.kb_id,
  });

  // Assemble answer up to char cap. Greedy: take chunks in score order
  // (already sorted by ChromaDB) until we'd exceed the cap.
  let answer = '';
  const sources: KnowledgeQueryResponse['sources'] = [];
  for (const hit of hits) {
    const next = answer.length === 0 ? hit.content : `\n\n${hit.content}`;
    if (answer.length + next.length > charCap) break;
    answer += next;
    sources.push({
      source_path: hit.metadata.source_path,
      content: hit.content,
      project_id: hit.metadata.project_id ?? body.kb_id,
    });
  }

  let result: KnowledgeQueryResponse = {
    ok: true,
    answer,
    sources,
    redactions_applied: false,
  };
  try {
    const after = applyResponseObligations(
      result as unknown as Record<string, unknown>,
      body.obligations,
    );
    result = after.payload as unknown as KnowledgeQueryResponse;
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
