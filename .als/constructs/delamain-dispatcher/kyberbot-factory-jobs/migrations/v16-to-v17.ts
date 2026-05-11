export async function migrate(): Promise<void> {
  // v17 moves drain acknowledgement onto a dedicated control plane, but it
  // does not change the persisted dispatcher state shape. Keep the sequential
  // construct-upgrade chain contiguous with a no-op migration step for 16 -> 17.
}
