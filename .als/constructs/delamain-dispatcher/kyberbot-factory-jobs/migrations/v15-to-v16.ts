export async function migrate(): Promise<void> {
  // v16 hardens merge-back publication and submodule invariants, but it does
  // not change the persisted dispatcher state shape. Keep the sequential
  // construct-upgrade chain contiguous with a no-op migration step for 15 -> 16.
}
