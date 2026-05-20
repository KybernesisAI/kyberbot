/**
 * Arcana service boot — composes structured + vector + embed + llm providers,
 * initialises the singleton, and returns a ServiceHandle for the orchestrator.
 *
 * Extracted from run.ts so the wiring is testable in isolation and the
 * graceful-degradation policy (vector optional, OpenAI optional) lives in
 * one named unit.
 */

import { join } from 'node:path';
import type { VectorStore } from '@kybernesis/arcana-contracts';
import { createLibsqlStructuredStore } from '@kybernesis/arcana-provider-libsql';
import { createChromaDBVectorStore } from './providers/chromadb-vector-store.js';
import { createOpenAIEmbeddingProvider } from './providers/openai-embedding-provider.js';
import { createClaudeLLMProvider } from './providers/claude-llm-provider.js';
import { getCollectionNameForRoot } from './embeddings.js';
import { initArcana, disposeArcana } from './arcana-singleton.js';
import { createLogger } from '../logger.js';
import type { ServiceHandle } from '../types.js';

const logger = createLogger('boot-arcana');

export async function bootArcana(root: string): Promise<ServiceHandle> {
  // Arcana requires an embedding provider. Today that means OpenAI — so a
  // missing API key disables Arcana entirely rather than failing the whole
  // service start. Existing dual-write code null-guards getArcanaInstance().
  // `.trim()` catches the common .env-with-trailing-whitespace footgun where
  // `OPENAI_API_KEY= ` parses to ' ', passes a falsy check, then fails at first
  // embed call deep inside the sleep cycle.
  if (!process.env.OPENAI_API_KEY?.trim()) {
    logger.warn('Arcana disabled — OPENAI_API_KEY not set (embedding provider unavailable)');
    return {
      stop: async () => {},
      status: () => 'disabled' as const,
    };
  }

  const dbPath = join(root, 'data', 'arcana.db');
  const structured = createLibsqlStructuredStore(dbPath);
  await structured.connect();

  // Once structured is connected, any subsequent failure must release the
  // libsql handle before propagating — otherwise a watchdog respawn would
  // race the leaked connection for the same .db file.
  try {
    const collectionName = getCollectionNameForRoot(root);
    let vector: VectorStore | undefined;
    try {
      const v = createChromaDBVectorStore({ collectionName });
      await v.connect();
      vector = v;
    } catch (err) {
      logger.warn('Arcana vector store unavailable — continuing without semantic mirror', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const embed = createOpenAIEmbeddingProvider();
    const llm = createClaudeLLMProvider();

    await initArcana({ structured, vector, embed, llm });

    return {
      stop: async () => {
        await disposeArcana();
      },
      status: () => 'running' as const,
    };
  } catch (err) {
    await structured.disconnect().catch(disconnectErr => {
      logger.warn('Arcana structured store disconnect failed during boot rollback', {
        error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
      });
    });
    throw err;
  }
}
