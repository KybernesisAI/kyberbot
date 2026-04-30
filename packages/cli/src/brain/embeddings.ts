/**
 * KyberBot — Embeddings Indexer
 *
 * Manages vector embeddings using ChromaDB for semantic search.
 * Uses OpenAI text-embedding-3-small for generating embeddings.
 *
 * ChromaDB must be running: docker-compose up -d
 */

import { ChromaClient, Collection, type IEmbeddingFunction } from 'chromadb';
import OpenAI from 'openai';
import { createLogger } from '../logger.js';
import { getIdentity, getIdentityForRoot, isFleetMode } from '../config.js';

const logger = createLogger('embeddings');

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface DocumentMetadata {
  type: 'conversation' | 'idea' | 'file' | 'transcript' | 'note';
  source_path: string;
  title?: string;
  timestamp: string;
  entities?: string[];
  topics?: string[];
  summary?: string;
  // ── ARP unification (Phase A) — agent-resource metadata ─────────────
  // Mirrors the canonical AgentResourceMetadata vocabulary from
  // @kybernesis/arp-spec. Lets typed /api/arp/*.search and .query
  // handlers filter ChromaDB results at the metadata layer (fast,
  // pre-LLM) instead of post-filtering. ChromaDB metadata values are
  // scalars; tags_csv stores tags as a comma-separated string for
  // `where: { tags_csv: { $like: '%marketing%' } }` style queries.
  project_id?: string;
  tags_csv?: string;
  classification?: 'public' | 'internal' | 'confidential' | 'pii';
  connection_id?: string;
  source_did?: string;
}

export interface SearchResult {
  id: string;
  content: string;
  metadata: DocumentMetadata;
  distance: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Derive a per-agent ChromaDB collection name.
 *
 * Strict in fleet mode: refuses to fall back to the singleton 'kyberbot_data'
 * collection. Silent fallback in fleet mode means every agent that hits the
 * fallback writes to the same shared collection — that's how cross-agent
 * contamination enters the vector store.
 *
 * Outside fleet mode (terminal/CLI/single-agent), the soft fallback is
 * preserved so fresh installs and edge cases still work.
 */
function getCollectionNameForRoot(root?: string): string {
  // Fleet mode: must have a root, must resolve to a real per-agent name.
  if (isFleetMode()) {
    if (!root) {
      throw new Error(
        'getCollectionNameForRoot called without a root in fleet mode. ' +
        'Caller must pass the agent root. Refusing to fall back to ' +
        '"kyberbot_data" — that would route every agent to the same ' +
        'shared ChromaDB collection and produce cross-agent contamination.'
      );
    }
    let identity;
    try {
      identity = getIdentityForRoot(root);
    } catch (err) {
      throw new Error(
        `getCollectionNameForRoot(${root}) failed to load identity.yaml in ` +
        `fleet mode: ${String(err)}. Refusing to fall back to "kyberbot_data".`
      );
    }
    const name = identity.agent_name;
    if (!name) {
      throw new Error(
        `getCollectionNameForRoot(${root}): identity.yaml has no agent_name ` +
        `in fleet mode. Refusing to fall back to "kyberbot_data".`
      );
    }
    const sanitized = name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/[^a-z0-9]+$/, '');
    if (!sanitized) {
      throw new Error(
        `getCollectionNameForRoot(${root}): agent_name "${name}" sanitizes ` +
        `to empty in fleet mode. Refusing to fall back to "kyberbot_data".`
      );
    }
    return `kyberbot_${sanitized}`;
  }

  // Non-fleet (terminal/CLI/single-agent): soft fallback preserved.
  try {
    const identity = root ? getIdentityForRoot(root) : getIdentity();
    if (identity.agent_name) {
      const sanitized = identity.agent_name
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .replace(/^[^a-z0-9]+/, '')
        .replace(/[^a-z0-9]+$/, '');
      if (sanitized.length >= 1) {
        return `kyberbot_${sanitized}`;
      }
    }
  } catch {
    // identity.yaml not available — use default
  }
  return 'kyberbot_data';
}

const CONFIG = {
  CHUNK_SIZE: 300,
  CHUNK_OVERLAP: 75,
  MAX_RESULTS: 20,
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'text-embedding-3-large',
};

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENTS (Lazy initialization)
// ═══════════════════════════════════════════════════════════════════════════════

// Shared clients (one connection regardless of how many agents)
let chromaClient: ChromaClient | null = null;
let openaiClient: OpenAI | null = null;
let chromaInitialized = false;
let chromaAvailable = false;

// Per-agent collections
const collections = new Map<string, Collection>();

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not set');
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const client = getOpenAIClient();
  const response = await client.embeddings.create({
    model: CONFIG.EMBEDDING_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const client = getOpenAIClient();
  const response = await client.embeddings.create({
    model: CONFIG.EMBEDDING_MODEL,
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}

export async function initializeEmbeddings(root?: string): Promise<boolean> {
  // If ChromaDB client not yet initialized, set it up
  if (!chromaInitialized) {
    chromaInitialized = true;

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      logger.warn('OPENAI_API_KEY not set - embeddings disabled');
      return false;
    }

    logger.info('Initializing ChromaDB...');

    try {
      const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8001';
      chromaClient = new ChromaClient({ path: chromaUrl });
      await chromaClient.heartbeat();
      chromaAvailable = true;
      logger.info(`ChromaDB client connected`, { url: chromaUrl });
    } catch {
      logger.warn('ChromaDB not available - run: docker-compose up -d');
      chromaAvailable = false;
      return false;
    }
  }

  if (!chromaAvailable || !chromaClient) return false;

  // Initialize per-agent collection if root is given and not yet loaded
  if (root && !collections.has(root)) {
    try {
      const openaiEmbedder: IEmbeddingFunction = {
        generate: async (texts: string[]): Promise<number[][]> => {
          return generateEmbeddings(texts);
        },
      };

      const collectionName = getCollectionNameForRoot(root);
      const col = await chromaClient.getOrCreateCollection({
        name: collectionName,
        embeddingFunction: openaiEmbedder,
        metadata: {
          description: 'KyberBot semantic search index',
          'hnsw:space': 'cosine',
        },
      });

      const count = await col.count();
      logger.info(`ChromaDB collection ready`, { collection: collectionName, documents: count });
      collections.set(root, col);
    } catch (error) {
      logger.error('Failed to initialize collection', { error: String(error) });
    }
  } else if (!root && collections.size === 0) {
    // Backward compat: no root given, use legacy getCollectionName
    try {
      const openaiEmbedder: IEmbeddingFunction = {
        generate: async (texts: string[]): Promise<number[][]> => {
          return generateEmbeddings(texts);
        },
      };

      const collectionName = getCollectionNameForRoot();
      const col = await chromaClient.getOrCreateCollection({
        name: collectionName,
        embeddingFunction: openaiEmbedder,
        metadata: {
          description: 'KyberBot semantic search index',
          'hnsw:space': 'cosine',
        },
      });

      const count = await col.count();
      logger.info(`ChromaDB connected`, { collection: collectionName, documents: count });
      collections.set('__default__', col);
    } catch (error) {
      logger.error('Failed to initialize default collection', { error: String(error) });
    }
  }

  return true;
}

export function isChromaAvailable(): boolean {
  return chromaAvailable;
}

/**
 * Reset the embeddings singleton state so the next call to initializeEmbeddings()
 * will re-establish connections. Used by the benchmark harness to reset between
 * conversations after deleting the ChromaDB collection.
 */
export function resetEmbeddings(root?: string): void {
  if (root) {
    collections.delete(root);
  } else {
    chromaClient = null;
    openaiClient = null;
    collections.clear();
    chromaInitialized = false;
    chromaAvailable = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEXT CHUNKING
// ═══════════════════════════════════════════════════════════════════════════════

interface TextChunk {
  text: string;
  index: number;
}

function chunkText(text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let currentChunk = '';
  let chunkIndex = 0;

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > CONFIG.CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push({ text: currentChunk.trim(), index: chunkIndex++ });

      // Keep overlap
      const words = currentChunk.split(' ');
      const overlapWords = words.slice(-Math.floor(CONFIG.CHUNK_OVERLAP / 5));
      currentChunk = overlapWords.join(' ') + ' ' + sentence;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
    }
  }

  if (currentChunk.trim()) {
    chunks.push({ text: currentChunk.trim(), index: chunkIndex });
  }

  return chunks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDEXING
// ═══════════════════════════════════════════════════════════════════════════════

export async function indexDocument(
  root: string,
  id: string,
  content: string,
  metadata: DocumentMetadata
): Promise<number> {
  if (!chromaInitialized) {
    await initializeEmbeddings(root);
  }

  // Fleet mode: never silently route to '__default__'. That fallback is the
  // path where Agent A's writes land in the shared default collection, then
  // Agent B's searches return Agent A's content as their own.
  let collection: Collection | undefined;
  if (isFleetMode()) {
    collection = collections.get(root);
    if (!collection) {
      throw new Error(
        `indexDocument(${root}): no per-agent collection initialized in fleet ` +
        `mode. Refusing to fall back to '__default__'. Did initializeEmbeddings(root) ` +
        `succeed? See earlier log lines for ChromaDB connection errors.`
      );
    }
  } else {
    collection = collections.get(root) || collections.get('__default__');
  }
  if (!chromaAvailable || !collection) {
    logger.debug(`Skipping indexing (ChromaDB not available): ${id}`);
    return 0;
  }

  if (!content || content.trim().length < 10) {
    logger.debug(`Skipping empty document: ${id}`);
    return 0;
  }

  const chunks = chunkText(content);
  logger.info(`Indexing document: ${id} (${chunks.length} chunks)`);

  try {
    // Generate embeddings for all chunks
    const embeddings = await generateEmbeddings(chunks.map((c) => c.text));

    const ids: string[] = [];
    const documents: string[] = [];
    const metadatas: Record<string, string | number>[] = [];

    for (let i = 0; i < chunks.length; i++) {
      ids.push(`${id}_chunk_${chunks[i].index}`);
      documents.push(chunks[i].text);
      // ── ARP unification (Phase A) — pass through agent-resource ──────
      // metadata fields when the producer set them. Empty string is the
      // ChromaDB-friendly null (avoids `undefined` filter issues) but
      // typed handlers SHOULD use `where: {project_id: 'alpha'}` not
      // `where: {project_id: ''}` for the unscoped lookup.
      const arpMeta: Record<string, string | number> = {};
      if (metadata.project_id) arpMeta['project_id'] = metadata.project_id;
      if (metadata.tags_csv) arpMeta['tags_csv'] = metadata.tags_csv;
      if (metadata.classification) arpMeta['classification'] = metadata.classification;
      if (metadata.connection_id) arpMeta['connection_id'] = metadata.connection_id;
      if (metadata.source_did) arpMeta['source_did'] = metadata.source_did;

      metadatas.push({
        type: metadata.type,
        source_path: metadata.source_path,
        title: metadata.title || '',
        timestamp: metadata.timestamp,
        chunk_index: chunks[i].index,
        parent_id: id,
        entities: metadata.entities?.join(',') || '',
        topics: metadata.topics?.join(',') || '',
        summary: metadata.summary || '',
        ...arpMeta,
      });
    }

    await collection.upsert({
      ids,
      documents,
      embeddings,
      metadatas,
    });

    logger.info(`Indexed: ${id} (${chunks.length} chunks)`);
    return chunks.length;
  } catch (error) {
    logger.error(`Failed to index ${id}`, { error: String(error) });
    return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

export async function semanticSearch(
  root: string,
  query: string,
  options: {
    limit?: number;
    type?: DocumentMetadata['type'];
    // ── ARP unification (Phase A/B) — metadata filters ────────────
    // Applied at the ChromaDB `where:` layer so out-of-scope chunks
    // are excluded BEFORE the result set leaves the vector store.
    // Defense in depth: cloud PDP gates whether the query happens;
    // these filters guarantee the result set stays scoped.
    project_id?: string;
    classification?: DocumentMetadata['classification'];
    connection_id?: string;
  } = {}
): Promise<SearchResult[]> {
  if (!chromaInitialized) {
    await initializeEmbeddings(root);
  }

  let collection: Collection | undefined;
  if (isFleetMode()) {
    collection = collections.get(root);
    if (!collection) {
      throw new Error(
        `semanticSearch(${root}): no per-agent collection initialized in fleet ` +
        `mode. Refusing to fall back to '__default__'. ` +
        `That fallback is exactly the cross-agent recall path we are closing.`
      );
    }
  } else {
    collection = collections.get(root) || collections.get('__default__');
  }
  if (!chromaAvailable || !collection) {
    logger.warn('Semantic search not available - ChromaDB not connected');
    return [];
  }

  const limit = options.limit || CONFIG.MAX_RESULTS;
  logger.info(`Searching: "${query}" (limit: ${limit})`);

  try {
    // Generate embedding for query
    const queryEmbedding = await generateEmbedding(query);

    // Build where filter — combine type + ARP metadata filters into a
    // single $and clause when more than one is set. ChromaDB requires
    // the $and operator for multi-condition filters.
    const conditions: Array<Record<string, unknown>> = [];
    if (options.type) conditions.push({ type: options.type });
    if (options.project_id) conditions.push({ project_id: options.project_id });
    if (options.classification) conditions.push({ classification: options.classification });
    if (options.connection_id) conditions.push({ connection_id: options.connection_id });
    const whereFilter =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? (conditions[0] as Record<string, string>)
          : { $and: conditions } as unknown as Record<string, string>;

    const results = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: limit,
      where: whereFilter,
    });

    const searchResults: SearchResult[] = [];

    if (results.ids[0]) {
      for (let i = 0; i < results.ids[0].length; i++) {
        const id = results.ids[0][i];
        const document = results.documents?.[0]?.[i];
        const metadata = results.metadatas?.[0]?.[i] as Record<string, unknown> | undefined;
        const distance = results.distances?.[0]?.[i];

        if (document && metadata) {
          const parentId = (metadata.parent_id as string) || id;
          searchResults.push({
            id: parentId,
            content: document,
            metadata: {
              type: metadata.type as DocumentMetadata['type'],
              source_path: metadata.source_path as string,
              title: metadata.title as string,
              timestamp: metadata.timestamp as string,
              entities: metadata.entities ? (metadata.entities as string).split(',').filter(Boolean) : undefined,
              topics: metadata.topics ? (metadata.topics as string).split(',').filter(Boolean) : undefined,
            },
            distance: distance || 0,
          });
        }
      }
    }

    logger.info(`Found ${searchResults.length} results for "${query}"`);
    return searchResults;
  } catch (error) {
    logger.error('Search failed', { error: String(error) });
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════════

export async function getIndexStats(root?: string): Promise<{
  totalChunks: number;
  available: boolean;
}> {
  if (!chromaInitialized) {
    await initializeEmbeddings(root);
  }

  let collection: Collection | undefined;
  if (isFleetMode()) {
    if (!root) {
      throw new Error(
        'getIndexStats called without a root in fleet mode. ' +
        'Pass the agent root explicitly. Refusing to fall back to ' +
        '__default__ or "first available collection" — both produce ' +
        'wrong-agent stats.'
      );
    }
    collection = collections.get(root);
  } else {
    collection = root ? collections.get(root) : (collections.get('__default__') || collections.values().next().value);
  }
  if (!chromaAvailable || !collection) {
    return { totalChunks: 0, available: false };
  }

  const count = await collection.count();
  return { totalChunks: count, available: true };
}
