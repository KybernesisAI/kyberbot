/**
 * Typed ARP request/response shapes.
 *
 * Each ARP scope id (see @kybernesis/arp-scope-catalog) maps to one
 * handler under this module. The shapes here are the WIRE contract
 * the cloud-bridge adapter ships when dispatching a structured
 * action — they intentionally include `project_id`, `tags`, etc. as
 * scoping inputs the data layer can filter by AT QUERY TIME, never
 * as inputs the handler trusts blindly.
 *
 * Compliance model:
 *   1. Cloud PDP gates whether the request happens at all (cedar
 *      policies referencing project_id, classification, tags).
 *   2. The handler here filters at the data layer using these same
 *      attributes — by construction, never by faith. If the brain
 *      stores a row with project_id=alpha, it returns; if not, the
 *      query shape excludes it. No "verify then return" path.
 *
 * Obligations attached to the cloud-side connection token (e.g.,
 * redact_fields_except, rate_limit, max_size_mb) are passed in the
 * request body so the handler applies them as code, not via LLM
 * prompting. See `obligations.ts` for the enforcement library.
 */

import type { ResourceClassification } from '@kybernesis/arp-spec';

/**
 * Obligations the cloud attached to this request. The handler is
 * responsible for honoring them deterministically — that's the
 * difference between policy-at-the-wire (LLM hopes to comply) and
 * policy-at-the-data-layer (code guarantees compliance).
 */
export interface ArpObligation {
  type: string;
  params: Record<string, unknown>;
}

/** Common envelope every typed ARP request body carries. */
export interface ArpRequestEnvelope {
  /** ARP connection_id this request is bound to. Used for audit + rate-limit scoping. */
  connection_id: string;
  /** Sender (peer) DID. Audit trail attribution; not trusted for routing. */
  source_did?: string;
  /** Obligations the handler must apply before returning. */
  obligations?: ArpObligation[];
}

// ── notes.search ──────────────────────────────────────────────────────

export interface NotesSearchRequest extends ArpRequestEnvelope {
  /** Required — facts/timeline rows are scoped to this project_id. */
  collection_id: string;
  /** Free-text query (FTS + semantic when ChromaDB is available). */
  query: string;
  /** Optional tag filter — match if ANY of these tags are present. */
  tags?: string[];
  /** Page size cap. Default 10, max 50. */
  limit?: number;
}

export interface NotesSearchResultItem {
  id: string;
  content: string;
  source_path: string;
  timestamp: string;
  /** Echo back the project so the caller can see where it came from. */
  project_id: string;
  classification?: ResourceClassification;
}

export interface NotesSearchResponse {
  ok: true;
  items: NotesSearchResultItem[];
  /** True when one or more obligations dropped/redacted fields in items. */
  redactions_applied: boolean;
}

// ── notes.read ────────────────────────────────────────────────────────

export interface NotesReadRequest extends ArpRequestEnvelope {
  collection_id: string;
  /** A `source_path` from a prior search result. */
  source_path: string;
}

export interface NotesReadResponse {
  ok: true;
  item: NotesSearchResultItem & { /* read may include extra fields if scope grants */ };
  redactions_applied: boolean;
}

// ── knowledge.query ───────────────────────────────────────────────────

export interface KnowledgeQueryRequest extends ArpRequestEnvelope {
  /** Knowledge base id == project_id in our model (scope template parameter is `kb_id`). */
  kb_id: string;
  query: string;
  /** Token cap; handler truncates to this. Default 4000, max 16000. */
  max_tokens?: number;
}

export interface KnowledgeQueryResponse {
  ok: true;
  /** Concatenated answer text, capped by max_tokens. */
  answer: string;
  /** Source chunks the answer was synthesized from (already scope-filtered). */
  sources: Array<{ source_path: string; content: string; project_id: string }>;
  redactions_applied: boolean;
}

// ── error envelope (every handler may return this instead of ok:true) ──

export interface ArpErrorResponse {
  ok: false;
  error:
    | 'bad_request'
    | 'forbidden'
    | 'rate_limited'
    | 'not_found'
    | 'internal'
    | 'obligation_unsatisfiable';
  reason?: string;
  /** Echo connection_id for audit correlation. */
  connection_id?: string;
}
