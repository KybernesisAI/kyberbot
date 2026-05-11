export async function migrate(): Promise<void> {
  // v18 adds publish-time replay inside merge-back, but it does not change the
  // persisted dispatcher runtime-state shape. Keep the sequential construct-upgrade
  // chain contiguous with a no-op migration step for 17 -> 18.
}
