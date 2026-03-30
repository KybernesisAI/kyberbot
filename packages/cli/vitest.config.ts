import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@anthropic-ai/claude-code': new URL('./src/types/claude-code-stub.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
  },
});
