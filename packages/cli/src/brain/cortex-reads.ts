/**
 * Cortex-reads flag — central gate for swapping KyberBot read paths to
 * call into `@kybernesis/cortex-*` instead of the local-store
 * implementations.
 *
 * Writes have always been dual-write since the adoption began (mirror
 * functions in fact-store, timeline, entity-graph, store-conversation).
 * Reads default to KyberBot's local stores. Setting
 * `KYBERBOT_USE_CORTEX_READS=1` flips every swappable read to its
 * Cortex equivalent.
 *
 * Off (default) — behaviour unchanged for everyone running KyberBot
 * without the flag.
 * On — agent reads from Cortex's mirror data. Same agent process,
 * runtime A/B by toggling the env var and restarting.
 *
 * The flag is read once at startup and cached. Restart the agent to
 * change it.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

let cached: boolean | null = null;

export function useCortexReads(): boolean {
  if (cached !== null) return cached;
  const raw = process.env.KYBERBOT_USE_CORTEX_READS?.trim().toLowerCase();
  cached = raw ? TRUTHY.has(raw) : false;
  return cached;
}

/** Reset the cache. Test-only — production callers should never invoke. */
export function resetCortexReadsCacheForTests(): void {
  cached = null;
}
