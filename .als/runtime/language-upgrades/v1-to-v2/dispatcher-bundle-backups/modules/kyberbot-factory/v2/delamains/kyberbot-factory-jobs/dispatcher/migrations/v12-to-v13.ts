export async function migrate(): Promise<void> {
  // v13 adds gpt-5.5 pricing coverage to the dispatcher runtime but does not
  // change the persisted dispatcher state shape. Keep the sequential registry
  // contiguous with a no-op migration step for 12 -> 13.
}
