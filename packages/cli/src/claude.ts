/**
 * KyberBot — Claude Abstraction Layer
 *
 * Two modes:
 *   1. SDK — Direct Anthropic API calls (requires ANTHROPIC_API_KEY)
 *   2. Subprocess — Spawns `claude -p` (requires Claude Code subscription)
 *
 * All brain AI operations go through this layer.
 */

import { spawn } from 'child_process';
import { getClaudeMode, getClaudeModel } from './config.js';
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
}

// Model ID mapping
const MODEL_IDS: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6-20250514',
  opus: 'claude-opus-4-6-20250514',
};

export class ClaudeClient {
  private mode: 'sdk' | 'subprocess';
  private sdk: any | null = null;

  constructor() {
    const configMode = getClaudeMode();
    this.mode = configMode === 'subscription' ? 'subprocess' : configMode;
    if (this.mode === 'sdk') {
      this.initSDK();
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
    const model = opts.model || getClaudeModel();

    if (this.mode === 'sdk' && this.sdk) {
      return this.completeSDK(prompt, model, opts);
    }
    return this.completeSubprocess(prompt, opts);
  }

  /**
   * Multi-turn chat
   */
  async chat(messages: Message[], system: string): Promise<string> {
    const model = getClaudeModel();

    if (this.mode === 'sdk' && this.sdk) {
      return this.chatSDK(messages, system, model);
    }
    // Subprocess mode: flatten into a single prompt with history
    const historyPrompt = messages
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    const fullPrompt = `${system}\n\n${historyPrompt}`;
    return this.completeSubprocess(fullPrompt, {});
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
      const args = ['-p', prompt];
      if (opts.system) {
        args.push('--system-prompt', opts.system);
      }

      const proc = spawn('claude', args, {
        env: {
          ...process.env,
          // Must unset CLAUDECODE to avoid Claude Code detecting nested invocation
          CLAUDECODE: '',
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
