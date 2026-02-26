/**
 * KyberBot — Claude Abstraction Layer
 *
 * Three modes:
 *   1. Agent SDK — Uses @anthropic-ai/claude-code (subscription users, recommended)
 *   2. SDK — Direct Anthropic API calls (requires ANTHROPIC_API_KEY)
 *   3. Subprocess — Spawns `claude -p` (fallback if Agent SDK fails to load)
 *
 * All brain AI operations go through this layer.
 */

import { spawn } from 'child_process';
import { getClaudeMode, getClaudeModel, getRoot } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('claude');

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompleteOptions {
  model?: 'haiku' | 'sonnet' | 'opus';
  system?: string;
  maxTokens?: number;
  maxTurns?: number;
}

// Model ID mapping
const MODEL_IDS: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6-20250514',
  opus: 'claude-opus-4-6-20250514',
};

export class ClaudeClient {
  private mode: 'agent-sdk' | 'sdk' | 'subprocess';
  private sdk: any | null = null;

  constructor() {
    const configMode = getClaudeMode();

    if (configMode === 'agent-sdk') {
      this.mode = 'agent-sdk';
      // Verify Agent SDK is loadable; fall back to subprocess if not
      this.verifyAgentSDK();
    } else if (configMode === 'sdk') {
      this.mode = 'sdk';
      this.initSDK();
    } else {
      this.mode = 'subprocess';
    }
  }

  private async verifyAgentSDK(): Promise<void> {
    try {
      await import('@anthropic-ai/claude-code');
      logger.debug('Agent SDK available');
    } catch {
      logger.warn('Agent SDK (@anthropic-ai/claude-code) not available, falling back to subprocess mode');
      this.mode = 'subprocess';
    }
  }

  private async initSDK(): Promise<void> {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      this.sdk = new Anthropic();
      logger.debug('Initialized in SDK mode');
    } catch {
      logger.warn('Failed to initialize SDK, falling back to subprocess mode');
      this.mode = 'subprocess';
    }
  }

  /**
   * Single completion — fire and forget prompt
   */
  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    // Always resolve model — never let subprocess/agent-sdk fall back to CLI defaults
    if (!opts.model) {
      opts.model = (getClaudeModel() || 'sonnet') as 'haiku' | 'sonnet' | 'opus';
    }

    if (this.mode === 'agent-sdk') {
      return this.completeAgentSDK(prompt, opts);
    }
    if (this.mode === 'sdk' && this.sdk) {
      return this.completeSDK(prompt, opts.model, opts);
    }
    return this.completeSubprocess(prompt, opts);
  }

  /**
   * Multi-turn chat
   */
  async chat(messages: Message[], system: string): Promise<string> {
    const model = (getClaudeModel() || 'sonnet') as 'haiku' | 'sonnet' | 'opus';

    if (this.mode === 'agent-sdk') {
      // Flatten messages into a prompt with history for Agent SDK
      const historyPrompt = messages
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
      return this.completeAgentSDK(historyPrompt, { system, model });
    }
    if (this.mode === 'sdk' && this.sdk) {
      return this.chatSDK(messages, system, model);
    }
    // Subprocess mode: flatten into a single prompt with history
    const historyPrompt = messages
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    const fullPrompt = `${system}\n\n${historyPrompt}`;
    return this.completeSubprocess(fullPrompt, { model });
  }

  private async completeAgentSDK(prompt: string, opts: CompleteOptions): Promise<string> {
    try {
      const { query } = await import('@anthropic-ai/claude-code');
      let root: string;
      try {
        root = getRoot();
      } catch {
        root = process.cwd();
      }

      const response = query({
        prompt,
        options: {
          cwd: root,
          maxTurns: opts.maxTurns ?? 10,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.system ? { customSystemPrompt: opts.system } : {}),
          permissionMode: 'bypassPermissions',
        },
      });

      // Collect all assistant text blocks as fallback
      let lastAssistantText = '';
      for await (const message of response) {
        if (message.type === 'assistant') {
          const content = (message as any).message?.content;
          if (Array.isArray(content)) {
            const text = content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('');
            if (text) lastAssistantText = text;
          }
        } else if (message.type === 'result') {
          const resultMsg = message as any;
          if (resultMsg.subtype === 'success') {
            // result field is the authoritative final text
            if (resultMsg.result) return resultMsg.result;
            // Agent may have done tool-only work (e.g. file edits) with no text reply
            logger.debug('Agent SDK returned success with empty result');
          } else {
            logger.warn(`Agent SDK error: ${resultMsg.subtype}`);
          }
        }
      }

      return lastAssistantText;
    } catch (err) {
      // Agent SDK failed (e.g. nested invocation, version mismatch) — fall back to subprocess
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.debug(`Agent SDK unavailable, using subprocess: ${errMsg}`);
      return this.completeSubprocess(prompt, opts);
    }
  }

  private async completeSDK(
    prompt: string,
    model: string,
    opts: CompleteOptions
  ): Promise<string> {
    const modelId = MODEL_IDS[model] || MODEL_IDS.sonnet;
    const response = await this.sdk.messages.create({
      model: modelId,
      max_tokens: opts.maxTokens || 4096,
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((b: any) => b.type === 'text');
    return textBlock?.text || '';
  }

  private async chatSDK(
    messages: Message[],
    system: string,
    model: string
  ): Promise<string> {
    const modelId = MODEL_IDS[model] || MODEL_IDS.sonnet;
    const response = await this.sdk.messages.create({
      model: modelId,
      max_tokens: 4096,
      system,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    });

    const textBlock = response.content.find((b: any) => b.type === 'text');
    return textBlock?.text || '';
  }

  private completeSubprocess(prompt: string, opts: CompleteOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      // Build flags first, then use '--' to separate the prompt
      // (prompts starting with '---' confuse CLI option parsers)
      const args = ['-p'];
      if (opts.system) {
        args.push('--system-prompt', opts.system);
      }
      if (opts.model) {
        args.push('--model', opts.model);
      }
      if (opts.maxTurns) {
        args.push('--max-turns', String(opts.maxTurns));
      }
      args.push('--', prompt);

      const proc = spawn('claude', args, {
        env: {
          ...process.env,
          // Must unset CLAUDECODE to avoid Claude Code detecting nested invocation
          CLAUDECODE: '',
          CLAUDE_CODE_ENTRYPOINT: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          logger.error(`claude subprocess exited with code ${code}`, { stderr });
          reject(new Error(`claude subprocess failed: ${stderr || `exit code ${code}`}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn claude: ${err.message}. Is Claude Code installed?`));
      });
    });
  }
}

// Singleton
let _client: ClaudeClient | null = null;

export function getClaudeClient(): ClaudeClient {
  if (!_client) {
    _client = new ClaudeClient();
  }
  return _client;
}
