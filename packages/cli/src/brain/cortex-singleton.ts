/**
 * Cortex singleton — boot/dispose wrapper around `createCortex()`.
 *
 * Created at orchestrator startup (after identity.yaml is loaded) via
 * `initCortex()`. Read elsewhere via `getCortexInstance()`, which returns
 * `null` until the orchestrator has wired providers. Callers must handle
 * the null case (local-only path) so KyberBot keeps working while Cortex
 * adoption is incremental.
 */

import { createCortex, type Cortex, type CortexOptions } from '@kybernesis/cortex-core';
import { createLogger } from '../logger.js';

const logger = createLogger('cortex-singleton');

let instance: Cortex | null = null;
let providers: CortexOptions | null = null;
// Serialises concurrent init attempts so that two callers (e.g. shared-process
// fleet mode booting two agents at once) cannot race the dispose-then-reinit
// sequence and leave one set of providers half-torn-down. The first call
// installs the in-flight promise; later concurrent callers await the same one.
let initInFlight: Promise<Cortex> | null = null;

export async function initCortex(opts: CortexOptions): Promise<Cortex> {
  if (initInFlight) return initInFlight;
  initInFlight = (async () => {
    if (instance) {
      logger.warn('initCortex called while an instance already exists — disposing previous instance first');
      await disposeCortex();
    }
    providers = opts;
    instance = createCortex(opts);
    return instance;
  })().finally(() => { initInFlight = null; });
  return initInFlight;
}

export function getCortexInstance(): Cortex | null {
  return instance;
}

export async function disposeCortex(): Promise<void> {
  if (!providers) return;
  const disconnects: Promise<unknown>[] = [providers.structured.disconnect()];
  if (providers.vector) disconnects.push(providers.vector.disconnect());
  const results = await Promise.allSettled(disconnects);
  for (const r of results) {
    if (r.status === 'rejected') {
      logger.warn('Cortex provider disconnect failed', {
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }
  instance = null;
  providers = null;
}

export function resetCortexForTests(): void {
  instance = null;
  providers = null;
  initInFlight = null;
}
