/**
 * Arcana singleton — boot/dispose wrapper around `createArcana()`.
 *
 * Created at orchestrator startup (after identity.yaml is loaded) via
 * `initArcana()`. Read elsewhere via `getArcanaInstance()`, which returns
 * `null` until the orchestrator has wired providers. Callers must handle
 * the null case (local-only path) so KyberBot keeps working while Arcana
 * adoption is incremental.
 */

import { createArcana, type Arcana, type ArcanaOptions } from '@kybernesisai/arcana-core';

let instance: Arcana | null = null;
let providers: ArcanaOptions | null = null;

export function initArcana(opts: ArcanaOptions): Arcana {
  if (instance) return instance;
  providers = opts;
  instance = createArcana(opts);
  return instance;
}

export function getArcanaInstance(): Arcana | null {
  return instance;
}

export async function disposeArcana(): Promise<void> {
  if (!providers) return;
  await Promise.allSettled([
    providers.structured.disconnect(),
    providers.vector.disconnect(),
  ]);
  instance = null;
  providers = null;
}

export function resetArcanaForTests(): void {
  instance = null;
  providers = null;
}
