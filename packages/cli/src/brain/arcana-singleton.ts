/**
 * Arcana singleton — boot/dispose wrapper around `createArcana()`.
 *
 * Created at orchestrator startup (after identity.yaml is loaded) via
 * `initArcana()`. Read elsewhere via `getArcanaInstance()`, which returns
 * `null` until the orchestrator has wired providers. Callers must handle
 * the null case (local-only path) so KyberBot keeps working while Arcana
 * adoption is incremental.
 */

import { createArcana, type Arcana, type ArcanaOptions } from '@kybernesis/arcana-core';
import { createLogger } from '../logger.js';

const logger = createLogger('arcana-singleton');

let instance: Arcana | null = null;
let providers: ArcanaOptions | null = null;
// Serialises concurrent init attempts so that two callers (e.g. shared-process
// fleet mode booting two agents at once) cannot race the dispose-then-reinit
// sequence and leave one set of providers half-torn-down. The first call
// installs the in-flight promise; later concurrent callers await the same one.
let initInFlight: Promise<Arcana> | null = null;

export async function initArcana(opts: ArcanaOptions): Promise<Arcana> {
  if (initInFlight) return initInFlight;
  initInFlight = (async () => {
    if (instance) {
      logger.warn('initArcana called while an instance already exists — disposing previous instance first');
      await disposeArcana();
    }
    providers = opts;
    instance = createArcana(opts);
    return instance;
  })().finally(() => { initInFlight = null; });
  return initInFlight;
}

export function getArcanaInstance(): Arcana | null {
  return instance;
}

export async function disposeArcana(): Promise<void> {
  if (!providers) return;
  const disconnects: Promise<unknown>[] = [providers.structured.disconnect()];
  if (providers.vector) disconnects.push(providers.vector.disconnect());
  const results = await Promise.allSettled(disconnects);
  for (const r of results) {
    if (r.status === 'rejected') {
      logger.warn('Arcana provider disconnect failed', {
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }
  instance = null;
  providers = null;
}

export function resetArcanaForTests(): void {
  instance = null;
  providers = null;
  initInFlight = null;
}
