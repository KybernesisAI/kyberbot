export async function migrate(): Promise<void> {
  // v14 adds same-state concurrency gating plus suppression telemetry, but it
  // does not change the persisted dispatcher state shape. Keep the sequential
  // registry contiguous with a no-op migration step for 13 -> 14.
}
