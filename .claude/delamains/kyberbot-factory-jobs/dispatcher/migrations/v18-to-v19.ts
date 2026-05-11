export async function migrate(): Promise<void> {
  // v19 adds primary-clone convergence follow-through plus the stale-base
  // pre-commit guard, but it does not change the persisted dispatcher
  // runtime-state shape. Keep the sequential construct-upgrade chain contiguous
  // with a no-op migration step for 18 -> 19.
}
