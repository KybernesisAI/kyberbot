import { describe, it, expect, vi } from 'vitest';
import { createClaudeLLMProvider } from './claude-llm-provider.js';
import type { ClaudeClient } from '../../claude.js';

function makeFakeClient(): { client: ClaudeClient; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async (_prompt: string, _opts?: unknown) => 'hello from claude');
  return { client: { complete } as unknown as ClaudeClient, complete };
}

describe('createClaudeLLMProvider', () => {
  it('defaults to haiku', () => {
    const { client } = makeFakeClient();
    const p = createClaudeLLMProvider({ client });
    expect(p.model).toBe('haiku');
  });

  it('respects an explicit model', () => {
    const { client } = makeFakeClient();
    const p = createClaudeLLMProvider({ client, model: 'sonnet' });
    expect(p.model).toBe('sonnet');
  });

  it('complete() forwards prompt + system, pins subprocess mode, drops unsupported opts', async () => {
    const { client, complete } = makeFakeClient();
    const p = createClaudeLLMProvider({ client, model: 'haiku' });
    const out = await p.complete('extract facts from: foo', {
      system: 'you are a fact extractor',
      // temperature and maxTokens are part of LLMCompleteOpts but the adapter
      // narrows them away — subprocess mode can't honour them.
      maxTokens: 512,
      temperature: 0.2,
    } as never);
    expect(out).toBe('hello from claude');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith('extract facts from: foo', expect.objectContaining({
      model: 'haiku',
      system: 'you are a fact extractor',
      subprocess: true,
    }));
    const [, calledOpts] = complete.mock.calls[0];
    expect(calledOpts).not.toHaveProperty('temperature');
    expect(calledOpts).not.toHaveProperty('maxTokens');
  });

  it('complete() works without opts', async () => {
    const { client, complete } = makeFakeClient();
    const p = createClaudeLLMProvider({ client });
    const out = await p.complete('hi');
    expect(out).toBe('hello from claude');
    expect(complete).toHaveBeenCalledWith('hi', expect.objectContaining({
      model: 'haiku',
      subprocess: true,
    }));
  });

  it('complete() propagates errors from the underlying client', async () => {
    const { client, complete } = makeFakeClient();
    complete.mockRejectedValueOnce(new Error('subprocess crashed'));
    const p = createClaudeLLMProvider({ client });
    await expect(p.complete('hi')).rejects.toThrow('subprocess crashed');
  });
});
