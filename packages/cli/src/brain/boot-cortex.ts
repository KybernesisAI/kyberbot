/**
 * Cortex service boot — composes structured + vector + embed + llm providers,
 * initialises the singleton, and returns a ServiceHandle for the orchestrator.
 *
 * Extracted from run.ts so the wiring is testable in isolation and the
 * graceful-degradation policy (vector optional, OpenAI optional) lives in
 * one named unit.
 */

import { join } from 'node:path';
import type { VectorStore } from '@kybernesis/cortex-contracts';
import { createLibsqlStructuredStore } from '@kybernesis/cortex-provider-libsql';
import { createSqliteVecVectorStore } from '@kybernesis/cortex-provider-sqlite-vec';
import { createOpenAIEmbeddingProvider } from './providers/openai-embedding-provider.js';
import { createClaudeLLMProvider } from './providers/claude-llm-provider.js';
import { initCortex, disposeCortex } from './cortex-singleton.js';
import { createLogger } from '../logger.js';
import type { ServiceHandle } from '../types.js';

const logger = createLogger('boot-cortex');

export async function bootCortex(root: string): Promise<ServiceHandle> {
  // Cortex requires an embedding provider. Today that means OpenAI — so a
  // missing API key disables Cortex entirely rather than failing the whole
  // service start. Existing dual-write code null-guards getCortexInstance().
  // `.trim()` catches the common .env-with-trailing-whitespace footgun where
  // `OPENAI_API_KEY= ` parses to ' ', passes a falsy check, then fails at first
  // embed call deep inside the sleep cycle.
  if (!process.env.OPENAI_API_KEY?.trim()) {
    logger.warn('Cortex disabled — OPENAI_API_KEY not set (embedding provider unavailable)');
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
    const embed = createOpenAIEmbeddingProvider();
    const llm = createClaudeLLMProvider();

    // sqlite-vec stores its index in a sibling .db file. Kept separate from
    // arcana.db so a vector reindex (model swap, dimension change, corruption)
    // can wipe vectors without touching the structured store.
    const vecDbPath = join(root, 'data', 'arcana-vec.db');
    let vector: VectorStore | undefined;
    try {
      const v = createSqliteVecVectorStore(vecDbPath, { dimensions: embed.dimensions });
      await v.connect();
      vector = v;
    } catch (err) {
      logger.warn('Cortex vector store unavailable — continuing without semantic mirror', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await initCortex({ structured, vector, embed, llm });

    return {
      stop: async () => {
        await disposeCortex();
      },
      status: () => 'running' as const,
    };
  } catch (err) {
    await structured.disconnect().catch(disconnectErr => {
      logger.warn('Cortex structured store disconnect failed during boot rollback', {
        error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
      });
    });
    throw err;
  }
}
