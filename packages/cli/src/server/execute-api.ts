/**
 * KyberBot — Execute API
 *
 * REST endpoint for executing Claude CLI commands with NDJSON streaming output.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Request, Response } from 'express';
import { getRoot } from '../config.js';
import { createLogger } from '../logger.js';

const logger = createLogger('execute');

// NDJSON helper
function sendLine(res: Response, obj: Record<string, unknown>) {
  if (!res.writableEnded) {
    res.write(JSON.stringify({ ...obj, ts: new Date().toISOString() }) + '\n');
  }
}

export async function executeHandler(req: Request, res: Response) {
  const { prompt, config, env: reqEnv } = req.body ?? {};

  // Validate
  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }

  // Set NDJSON streaming headers
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Resolve instance root
  const cwd = process.env.KYBERBOT_ROOT || getRoot();

  // Build claude args
  const args: string[] = ['--print', '-', '--output-format', 'stream-json', '--verbose'];

  const cfg = config ?? {};
  if (cfg.model) args.push('--model', String(cfg.model));
  if (cfg.effort) args.push('--effort', String(cfg.effort));
  if (cfg.maxTurns) args.push('--max-turns', String(cfg.maxTurns));
  if (cfg.sessionId) args.push('--resume', String(cfg.sessionId));
  if (cfg.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');

  // Build environment - merge request env vars
  const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  if (reqEnv && typeof reqEnv === 'object') {
    for (const [key, value] of Object.entries(reqEnv)) {
      if (typeof value === 'string') {
        childEnv[key] = value;
      }
    }
  }

  logger.info(`Executing claude in ${cwd} with ${args.length} args`);

  let proc: ChildProcess;
  try {
    proc = spawn('claude', args, {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    sendLine(res, { type: 'error', message: `Failed to spawn claude: ${err}` });
    res.end();
    return;
  }

  // Track stdout for final parsing
  let stdout = '';
  let killed = false;

  // Send prompt on stdin
  if (proc.stdin) {
    proc.stdin.write(prompt);
    proc.stdin.end();
  }

  // Stream stdout as NDJSON log lines
  proc.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    sendLine(res, { type: 'log', stream: 'stdout', chunk: text });
  });

  // Stream stderr as NDJSON log lines
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    sendLine(res, { type: 'log', stream: 'stderr', chunk: text });
  });

  // Keepalive timer (every 30s)
  const keepalive = setInterval(() => {
    sendLine(res, { type: 'keepalive' });
  }, 30_000);

  // Handle client disconnect (use res, not req — req 'close' fires when body is consumed)
  res.on('close', () => {
    if (!res.writableFinished && !proc.killed && !killed) {
      logger.warn('Client disconnected, killing subprocess');
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5_000);
    }
  });

  // Handle process exit
  proc.on('close', (exitCode, signal) => {
    clearInterval(keepalive);

    if (killed) {
      sendLine(res, { type: 'error', message: 'Process killed due to client disconnect' });
      res.end();
      return;
    }

    // Parse stdout to extract result metadata
    const result = parseStreamJsonResult(stdout);
    // Release stdout buffer immediately — can be very large for stream-json
    stdout = '';

    sendLine(res, {
      type: 'result',
      exitCode: exitCode ?? null,
      signal: signal ?? null,
      sessionId: result.sessionId,
      model: result.model,
      usage: result.usage,
      costUsd: result.costUsd,
      summary: result.summary,
      resultJson: result.resultJson,
    });

    res.end();
    logger.info(`Claude exited with code ${exitCode}`);
  });

  proc.on('error', (err) => {
    clearInterval(keepalive);
    sendLine(res, { type: 'error', message: `Process error: ${err.message}` });
    res.end();
  });
}

// Parse stream-json stdout to extract final result metadata
function parseStreamJsonResult(stdout: string) {
  let sessionId: string | null = null;
  let model = '';
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const type = typeof event.type === 'string' ? event.type : '';

    if (type === 'system' && event.subtype === 'init') {
      sessionId = typeof event.session_id === 'string' ? event.session_id : sessionId;
      model = typeof event.model === 'string' ? event.model : model;
      continue;
    }

    if (type === 'assistant') {
      sessionId = typeof event.session_id === 'string' ? event.session_id : sessionId;
      const message = typeof event.message === 'object' && event.message ? event.message as Record<string, unknown> : {};
      const content = Array.isArray(message.content) ? message.content : [];
      for (const entry of content) {
        if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
          const block = entry as Record<string, unknown>;
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            assistantTexts.push(block.text);
          }
        }
      }
      continue;
    }

    if (type === 'result') {
      finalResult = event;
      sessionId = typeof event.session_id === 'string' ? event.session_id : sessionId;
    }
  }

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null as number | null,
      usage: null as { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null,
      summary: assistantTexts.join('\n\n').trim(),
      resultJson: null as Record<string, unknown> | null,
    };
  }

  const usageObj = typeof finalResult.usage === 'object' && finalResult.usage ? finalResult.usage as Record<string, unknown> : {};
  const usage = {
    inputTokens: typeof usageObj.input_tokens === 'number' ? usageObj.input_tokens : 0,
    outputTokens: typeof usageObj.output_tokens === 'number' ? usageObj.output_tokens : 0,
    cachedInputTokens: typeof usageObj.cache_read_input_tokens === 'number' ? usageObj.cache_read_input_tokens : 0,
  };
  const costRaw = finalResult.total_cost_usd;
  const costUsd = typeof costRaw === 'number' && Number.isFinite(costRaw) ? costRaw : null;
  const summary = typeof finalResult.result === 'string' ? finalResult.result.trim() : assistantTexts.join('\n\n').trim();

  return { sessionId, model, costUsd, usage, summary, resultJson: finalResult };
}
