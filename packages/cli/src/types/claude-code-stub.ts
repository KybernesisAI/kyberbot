// Stub for @anthropic-ai/claude-code — the package is a CLI tool without
// proper ESM exports, which breaks Vite's import analysis in tests.
export async function* query(): AsyncGenerator<never> {
  throw new Error('claude-code SDK not available in test environment');
}
