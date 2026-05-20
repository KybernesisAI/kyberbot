/**
 * ChromaDB implementation of Arcana's `VectorStore` contract.
 *
 * Module #3 of the Arcana adoption — KyberBot-side adapter that lets
 * Arcana's kernel (chunking, hybrid retrieval, sleep pipeline) reach
 * a ChromaDB collection without depending on the `chromadb` SDK
 * directly.
 *
 * Each adapter instance binds to one collection. Multi-agent setups
 * construct one adapter per agent (collection name derived from the
 * agent's identity by the consumer, not this class).
 */

import { ChromaClient, type Collection } from 'chromadb';
import type {
  VectorStore,
  VectorItem,
  VectorQueryOpts,
  VectorMatch,
} from '@kybernesis/arcana-contracts';
import { createLogger } from '../../logger.js';

const logger = createLogger('chromadb-vector-store');

export interface ChromaDBVectorStoreOptions {
  /** Collection name. Required — one adapter == one collection. */
  collectionName: string;
  /** ChromaDB server URL. Defaults to env CHROMA_URL or 'http://localhost:8001'. */
  url?: string;
  /** Optional injected client (for tests). */
  client?: ChromaClient;
  /** HNSW space (similarity metric). Defaults to 'cosine'. */
  space?: 'cosine' | 'l2' | 'ip';
  /** Optional human-readable collection description. */
  description?: string;
}

/**
 * Convert Chroma's distance (cosine: 0 = identical, 2 = opposite) into a
 * normalised score (0..1, higher is better). For cosine: `score = 1 - d/2`.
 */
function distanceToScore(distance: number, space: 'cosine' | 'l2' | 'ip'): number {
  if (space === 'cosine') return Math.max(0, 1 - distance / 2);
  if (space === 'ip') return distance;
  return 1 / (1 + distance);
}

export function createChromaDBVectorStore(opts: ChromaDBVectorStoreOptions): VectorStore {
  const url = opts.url ?? process.env.CHROMA_URL ?? 'http://localhost:8001';
  const space = opts.space ?? 'cosine';
  const client = opts.client ?? new ChromaClient({ path: url });

  let collection: Collection | null = null;

  async function ensureCollection(): Promise<Collection> {
    if (collection) return collection;
    throw new Error('ChromaDBVectorStore: connect() must be called before use');
  }

  return {
    async connect(): Promise<void> {
      if (collection) return;
      await client.heartbeat();
      collection = await client.getOrCreateCollection({
        name: opts.collectionName,
        metadata: {
          description: opts.description ?? 'Arcana VectorStore (ChromaDB adapter)',
          'hnsw:space': space,
        },
      });
      const count = await collection.count();
      logger.info('ChromaDB vector store connected', {
        collection: opts.collectionName,
        documents: count,
      });
    },

    async disconnect(): Promise<void> {
      collection = null;
    },

    async upsert(items: VectorItem[]): Promise<void> {
      if (items.length === 0) return;
      const col = await ensureCollection();

      const ids = items.map(i => i.id);
      const embeddings = items.map(i => i.vector);
      const metadatas = items.map(i => (i.metadata ?? {}) as Record<string, string | number | boolean>);

      await col.upsert({ ids, embeddings, metadatas });
    },

    async query(vector: number[], queryOpts: VectorQueryOpts = {}): Promise<VectorMatch[]> {
      const col = await ensureCollection();
      const topK = queryOpts.topK ?? 10;
      const where = queryOpts.filter as Record<string, unknown> | undefined;

      const results = await col.query({
        queryEmbeddings: [vector],
        nResults: topK,
        where: where as Record<string, string> | undefined,
      });

      const ids = results.ids?.[0] ?? [];
      const distances = results.distances?.[0] ?? [];
      const metadatas = results.metadatas?.[0] ?? [];

      const matches: VectorMatch[] = [];
      for (let i = 0; i < ids.length; i++) {
        matches.push({
          id: ids[i],
          score: distanceToScore(distances[i] ?? 0, space),
          metadata: (metadatas[i] ?? undefined) as Record<string, unknown> | undefined,
        });
      }
      return matches;
    },

    async delete(ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      const col = await ensureCollection();
      await col.delete({ ids });
    },
  };
}
