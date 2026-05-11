export async function migrate(): Promise<void> {
  // v15 adds cross-state concurrency pool gating plus enriched suppression
  // telemetry, but it does not change the persisted dispatcher state shape.
  // Keep the sequential registry contiguous with a no-op migration step for
  // 14 -> 15.
}
