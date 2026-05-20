/**
 * OpenAI implementation of Arcana's `EmbeddingProvider` contract.
 *
 * Module #3 of the Arcana adoption — KyberBot-side adapter that lets
 * Arcana's kernel (chunking, hybrid retrieval, sleep pipeline) reach
 * OpenAI's embedding endpoint without taking a direct dep on `openai`.
 */

import OpenAI from 'openai';
import type { EmbeddingProvider } from '@kybernesis/arcana-contracts';
import { createLogger } from '../../logger.js';

const logger = createLogger('openai-embedding-provider');

export interface OpenAIEmbeddingProviderOptions {
  /** Override the OpenAI API key. Defaults to env OPENAI_API_KEY. */
  apiKey?: string;
  /** Embedding model id. Defaults to env EMBEDDING_MODEL or 'text-embedding-3-large'. */
  model?: string;
  /**
   * Hardcoded dimension count for the chosen model. Required because Arcana's
   * `EmbeddingProvider.dimensions` is sync (no probing) and OpenAI's API
   * doesn't expose it before the first call. Defaults derived from model name.
   */
  dimensions?: number;
  /** Injectable client for tests. */
  client?: OpenAI;
}

const DEFAULT_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

export function createOpenAIEmbeddingProvider(
  opts: OpenAIEmbeddingProviderOptions = {},
): EmbeddingProvider {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  const model = opts.model ?? process.env.EMBEDDING_MODEL ?? 'text-embedding-3-large';
  const dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS[model];

  if (!apiKey && !opts.client) {
    throw new Error('OpenAIEmbeddingProvider: OPENAI_API_KEY not set (or pass opts.apiKey / opts.client)');
  }
  if (!dimensions) {
    throw new Error(`OpenAIEmbeddingProvider: unknown dimensions for model "${model}" — pass opts.dimensions`);
  }

  const client = opts.client ?? new OpenAI({ apiKey });

  return {
    model,
    dimensions,

    async embed(text: string): Promise<number[]> {
      const response = await client.embeddings.create({ model, input: text });
      const vector = response.data[0]?.embedding;
      if (!vector) {
        logger.error('OpenAI returned empty embedding response', { textLen: text.length });
        throw new Error('OpenAI embedding response missing vector');
      }
      return vector;
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const response = await client.embeddings.create({ model, input: texts });
      return response.data.map(d => d.embedding);
    },
  };
}
