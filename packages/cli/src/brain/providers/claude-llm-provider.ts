/**
 * KyberBot ClaudeClient adapter for Arcana's `LLMProvider` contract.
 *
 * Lets Arcana's kernel (sleep-pipeline fact extraction, summarisation,
 * reasoning) reach Claude through KyberBot's existing three-mode runtime
 * (Agent SDK / SDK / subprocess) without depending on the underlying
 * client directly.
 */

import type { LLMProvider, LLMCompleteOpts } from '@kybernesis/cortex-contracts';
import { ClaudeClient, getClaudeClient } from '../../claude.js';

export interface ClaudeLLMProviderOptions {
  /** Claude model shorthand. Defaults to 'haiku' — cheapest for sleep-pipeline use. */
  model?: 'haiku' | 'sonnet' | 'opus';
  /** Injectable client for tests. */
  client?: ClaudeClient;
}

// `temperature` and `maxTokens` are intentionally dropped: KyberBot's ClaudeClient
// pins subprocess mode (claude.ts:91-95 forces it for memory safety), and `claude -p`
// exposes neither flag. Plumbing them would require new SDK + subprocess paths with
// no kernel consumer asking for them today. The adapter narrows the contract to
// match what subprocess mode can actually honour.
type SupportedLLMCompleteOpts = Omit<LLMCompleteOpts, 'temperature' | 'maxTokens'>;

export function createClaudeLLMProvider(
  opts: ClaudeLLMProviderOptions = {},
): LLMProvider {
  const model = opts.model ?? 'haiku';
  const client = opts.client ?? getClaudeClient();

  return {
    model,

    async complete(prompt: string, completeOpts: SupportedLLMCompleteOpts = {}): Promise<string> {
      return client.complete(prompt, {
        model,
        system: completeOpts.system,
        subprocess: true,
      });
    },
  };
}
