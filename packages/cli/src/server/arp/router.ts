/**
 * /api/arp/* — typed ARP endpoint surface.
 *
 * Mounted by the agent-router at /api/arp; each route below maps to
 * one ARP scope-catalog action. Cloud-bridge dispatches structured
 * actions (ctx.body.action) to these endpoints; chat-style actions
 * (relay_to_principal) keep using /api/web/chat as before.
 *
 * Endpoint contract (one shape across all handlers):
 *
 *   POST /api/arp/<scope-id>
 *     Body: { connection_id, source_did?, obligations?, ...action-specific params }
 *     200: { ok: true, ...response, redactions_applied }
 *     400/403/404/422/429: { ok: false, error, reason?, connection_id? }
 *
 * Defense in depth:
 *   - Cloud PDP gates whether the request reaches the agent at all
 *     (cedar policies referencing the same dimensions).
 *   - Each handler filters at the data layer using project_id /
 *     classification / tags. By construction, never trust-and-verify.
 *   - Obligations apply as code (see ./obligations.ts), not via LLM
 *     prompting.
 *
 * Phase B baseline endpoints; more land in PR-AC-4 (files.*, tasks.*,
 * calendar.*) plus the local audit chain.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { handleNotesSearch } from './handler-notes-search.js';
import { handleNotesRead } from './handler-notes-read.js';
import { handleKnowledgeQuery } from './handler-knowledge-query.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('arp-router');

export function createArpRouter(root: string): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      endpoints: ['notes.search', 'notes.read', 'knowledge.query'],
      // Will surface in cloud dashboard "KyberBot brain health" panel
      // (Phase E.3) — for now the static list lets a peer probe
      // capability before composing a typed request.
    });
  });

  router.post('/notes.search', wrap('notes.search', (req, res) => handleNotesSearch(root, req, res)));
  router.post('/notes.read', wrap('notes.read', (req, res) => handleNotesRead(root, req, res)));
  router.post('/knowledge.query', wrap('knowledge.query', (req, res) => handleKnowledgeQuery(root, req, res)));

  return router;
}

/**
 * Wrap handler in async-error catching so a thrown exception turns
 * into a 500 with a logged stack rather than a hung request. Each
 * handler is responsible for its own happy + expected-error paths;
 * this only catches programmer bugs.
 */
function wrap(
  action: string,
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch((err) => {
      logger.error('ARP handler crashed', { action, err: String(err) });
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: 'internal',
          reason: 'unhandled error in ARP handler',
        });
      }
      next();
    });
  };
}
