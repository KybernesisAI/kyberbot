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

const CONFIG = {
  COLLECTION_NAME: 'kyberbot_data',
  CHUNK_SIZE: 500,
  CHUNK_OVERLAP: 50,
  MAX_RESULTS: 20,
  EMBEDDING_MODEL: 'text-embedding-3-small',
};

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENTS (Lazy initialization)
// ═══════════════════════════════════════════════════════════════════════════════

let chromaClient: ChromaClient | null = null;
let openaiClient: OpenAI | null = null;
let collection: Collection | null = null;
let chromaInitialized = false;
let chromaAvailable = false;

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

export async function initializeEmbeddings(): Promise<boolean> {
  if (chromaInitialized) return chromaAvailable;
  chromaInitialized = true;

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    logger.warn('OPENAI_API_KEY not set - embeddings disabled');
    return false;
  }

  logger.info('Initializing ChromaDB...');

  try {
    // Connect to ChromaDB server
    const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8000';
    const url = new URL(chromaUrl);
    chromaClient = new ChromaClient({
      path: chromaUrl,
    });

    // Test connection
    await chromaClient.heartbeat();

    // Create embedding function wrapper for ChromaDB
    const openaiEmbedder: IEmbeddingFunction = {
      generate: async (texts: string[]): Promise<number[][]> => {
        return generateEmbeddings(texts);
      },
    };

    // Get or create collection with our OpenAI embedding function
    collection = await chromaClient.getOrCreateCollection({
      name: CONFIG.COLLECTION_NAME,
      embeddingFunction: openaiEmbedder,
      metadata: {
        description: 'KyberBot semantic search index',
        'hnsw:space': 'cosine',
      },
    });

    const count = await collection.count();
    logger.info(`ChromaDB connected`, { documents: count, url: chromaUrl });
    chromaAvailable = true;
    return true;
  } catch (error) {
    logger.warn('ChromaDB not available - run: docker-compose up -d');
    chromaAvailable = false;
    return false;
  }
}

export function isChromaAvailable(): boolean {
  return chromaAvailable;
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
  id: string,
  content: string,
  metadata: DocumentMetadata
): Promise<number> {
  if (!chromaInitialized) {
    await initializeEmbeddings();
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
  query: string,
  options: {
    limit?: number;
    type?: DocumentMetadata['type'];
  } = {}
): Promise<SearchResult[]> {
  if (!chromaInitialized) {
    await initializeEmbeddings();
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

    // Build where filter
    const whereFilter = options.type ? { type: options.type } : undefined;

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

export async function getIndexStats(): Promise<{
  totalChunks: number;
  available: boolean;
}> {
  if (!chromaInitialized) {
    await initializeEmbeddings();
  }

  if (!chromaAvailable || !collection) {
    return { totalChunks: 0, available: false };
  }

  const count = await collection.count();
  return { totalChunks: count, available: true };
}
