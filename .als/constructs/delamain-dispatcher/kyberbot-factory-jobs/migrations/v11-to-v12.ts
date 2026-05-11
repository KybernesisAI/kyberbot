export async function migrate(): Promise<void> {
  // v12 adds the dispatcher drain control surface but does not change the
  // persisted dispatcher state shape. The version bump still needs a no-op
  // migration step so the sequential registry can traverse 11 -> 12.
}
