/**
 * KyberBot — Real-Time Fact Extraction
 *
 * Lightweight inline fact extraction that runs immediately after a
 * conversation is stored, so facts are available right away instead
 * of waiting for the next sleep cycle.
 *
 * Uses Claude Haiku for cheap, fast extraction — capped at 3 facts
 * per conversation to keep latency low.
 */

import { getClaudeClient } from '../claude.js';
import { storeFact, ensureFactsTable, type FactInput, type FactCategory, type SpeakerId, type SpeechType, VALID_CATEGORIES, VALID_SPEAKER_IDS, VALID_SPEECH_TYPES } from './fact-store.js';
import { detectTemporalExpiry } from './fact-temporal.js';
import { createLogger } from '../logger.js';
import { SOURCE_CONFIDENCE } from './store-conversation.js';

const logger = createLogger('fact-extractor');

const REALTIME_FACT_PROMPT = `Extract 1-3 concrete facts about specific people, companies, or projects from this conversation. Only clear, verifiable facts — skip vague observations, greetings, and meta-commentary.

The conversation is pre-labeled: "User:" lines are from the human or incoming agent, "Assistant:" lines are from this AI agent.

Each fact object has:
- "content": The fact statement (8-25 words, include names not pronouns)
- "category": One of: biographical, preference, event, relationship, temporal, opinion, plan, general
- "confidence": 0.5-0.9 (how confident you are)
- "entities": Array of person/entity names
- "speaker_id": who said the thing this fact was extracted from — one of: user, agent, external_party, system
- "speech_type": what kind of utterance — one of: user_utterance, agent_utterance, quoted_external, reported_speech, hypothetical, acknowledgment, system_event

Attribution rules:
- Facts from "User:" lines → speaker_id: "user", speech_type: "user_utterance" (default)
- Facts from "Assistant:" lines → speaker_id: "agent", speech_type: "agent_utterance"
- If a fact comes from a paste, forward, or quote inside either turn → speaker_id: "external_party", speech_type: "quoted_external"
- Hypotheticals ("if X happened", "imagine if") → speech_type: "hypothetical"
- Do NOT extract facts from acknowledgment turns ("Thanks!", "Got it", "Sure") — emit speech_type: "acknowledgment" only if you must represent the turn, but skip extraction for those

Return a JSON array, or [] if no concrete facts.

Conversation:
`;

/**
 * Extract facts from a conversation in real-time (best-effort).
 * Called after entity graph storage in storeConversation().
 * Never throws — all errors are caught and logged.
 */
export async function extractFactsRealtime(
  root: string,
  text: string,
  entities: string[],
  sourcePath: string,
  conversationId: string,
  timestamp: string,
  sourceType: string = 'chat',
  // ── ARP unification (Phase A) — agent-resource metadata ───────────
  // Defined in @kybernesis/arp-spec :: AgentResourceMetadata. Stamped
  // onto every fact extracted from this conversation so typed
  // /api/arp/* handlers can filter by project_id / classification /
  // connection_id at query time. All optional — pass through whatever
  // context the caller has.
  arpMetadata?: {
    project_id?: string;
    tags?: string[];
    classification?: 'public' | 'internal' | 'confidential' | 'pii';
    connection_id?: string;
    source_did?: string;
  }
): Promise<number> {
  // Guard: skip short conversations or those with no entities
  if (text.length < 50 || entities.length === 0) {
    return 0;
  }

  await ensureFactsTable(root);

  let factsCreated = 0;

  try {
    const client = getClaudeClient();
    const content = text.slice(0, 2000); // Cap input to keep Haiku fast

    const response = await client.complete(
      REALTIME_FACT_PROMPT + content,
      {
        model: 'haiku',
        maxTokens: 256,
        maxTurns: 1,
        subprocess: true,
        cwd: root,
      }
    );

    // Parse JSON array from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return 0;

    let rawFacts: Array<{
      content: string;
      category: string;
      confidence: number;
      entities: string[];
      speaker_id?: string;
      speech_type?: string;
    }>;

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return 0;
      rawFacts = parsed;
    } catch {
      return 0;
    }

    // Validate and store up to 3 facts
    const parentId = sourcePath.replace('channel://', '');
    const maxConfidence = SOURCE_CONFIDENCE[sourceType] ?? 0.85;

    for (const [i, fact] of rawFacts.slice(0, 3).entries()) {
      // Validate content
      if (!fact.content || fact.content.length < 10 || fact.content.length > 200) continue;
      if (!fact.entities || fact.entities.length === 0) continue;

      // Skip acknowledgment turns — they carry no extractable facts
      if (fact.speech_type === 'acknowledgment') continue;

      // Validate speaker attribution — skip rather than write 'unknown' at runtime
      const speaker_id = VALID_SPEAKER_IDS.has(fact.speaker_id ?? '') ? fact.speaker_id as SpeakerId : null;
      const speech_type = VALID_SPEECH_TYPES.has(fact.speech_type ?? '') ? fact.speech_type as SpeechType : null;

      if (!speaker_id || speaker_id === 'unknown' || !speech_type || speech_type === 'unknown') {
        logger.warn('Skipping fact with unresolved speaker attribution', {
          content: fact.content.slice(0, 60),
          speaker_id: fact.speaker_id,
          speech_type: fact.speech_type,
        });
        continue;
      }

      const category = VALID_CATEGORIES.has(fact.category) ? fact.category : 'general';
      // Cap confidence: AI-extracted facts shouldn't exceed source confidence
      const confidence = Math.min(fact.confidence || 0.6, maxConfidence, 0.60);

      const factInput: FactInput = {
        content: fact.content,
        source_path: `realtime://${parentId}/${i}`,
        source_conversation_id: parentId,
        entities: fact.entities,
        timestamp,
        confidence,
        category: category as FactCategory,
        speaker_id,
        speech_type,
        source_type: 'ai-extraction',
        ...(arpMetadata?.project_id ? { project_id: arpMetadata.project_id } : {}),
        ...(arpMetadata?.tags ? { tags: arpMetadata.tags } : {}),
        ...(arpMetadata?.classification ? { classification: arpMetadata.classification } : {}),
        ...(arpMetadata?.connection_id ? { connection_id: arpMetadata.connection_id } : {}),
        ...(arpMetadata?.source_did ? { source_did: arpMetadata.source_did } : {}),
      };

      // Detect temporal expressions and set automatic expiry
      const temporal = detectTemporalExpiry(fact.content, timestamp);
      if (temporal.expires_at) {
        factInput.expires_at = temporal.expires_at;
      }

      try {
        await storeFact(root, factInput);
        factsCreated++;
        // Contradiction detection is NOT run in the real-time path. The
        // sleep-cycle observe step calls `detectContradictions` on every
        // fact it sees (including ones stored here), and runs every 3h.
        // Running it twice — once inline and once in sleep — doubles the
        // Haiku call count for this responsibility without improving
        // correctness. Sleep's pass is the single source of truth.
      } catch {
        // Individual fact storage is best-effort
      }
    }

    if (factsCreated > 0) {
      logger.debug('Real-time facts extracted', {
        conversationId,
        factsCreated,
        sourceType,
      });
    }
  } catch (err) {
    logger.debug('Real-time fact extraction skipped', { error: String(err) });
  }

  return factsCreated;
}
