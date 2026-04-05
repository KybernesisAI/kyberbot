/**
 * KyberBot — Management API
 *
 * REST endpoints for managing skills, agents, channels, and heartbeat.
 * Used by the KyberBot Desktop app and benefits the web UI too.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'node:child_process';
import { paths, getRoot, getClaudeModel } from '../config.js';
import { loadInstalledSkills, getSkill } from '../skills/loader.js';
import { scaffoldSkill } from '../skills/scaffolder.js';
import { removeSkill, rebuildClaudeMd } from '../skills/registry.js';
import { loadInstalledAgents, getAgent } from '../agents/loader.js';
import { scaffoldAgent } from '../agents/scaffolder.js';
import { removeAgent } from '../agents/registry.js';
import { buildSystemPrompt } from '../agents/spawner.js';
import { Channel } from './channels/types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('management-api');

/**
 * Wrap async route handlers so errors propagate to Express error middleware.
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export function createManagementRouter(channels: Channel[]): Router {
  const router = Router();

  // ─────────────────────────────────────────────────────────────────
  // Skills
  // ─────────────────────────────────────────────────────────────────

  // GET /skills — List all installed skills
  router.get('/skills', (_req, res) => {
    try {
      const skills = loadInstalledSkills();
      res.json({ skills });
    } catch (err) {
      logger.error('Failed to list skills', { error: String(err) });
      res.status(500).json({ error: 'Failed to list skills' });
    }
  });

  // GET /skills/:name — Get a specific skill
  router.get('/skills/:name', (req, res) => {
    try {
      const skill = getSkill(req.params.name);
      if (!skill) {
        res.status(404).json({ error: `Skill not found: ${req.params.name}` });
        return;
      }
      res.json(skill);
    } catch (err) {
      logger.error('Failed to get skill', { error: String(err) });
      res.status(500).json({ error: 'Failed to get skill' });
    }
  });

  // GET /skills/:name/content — Read SKILL.md content
  router.get('/skills/:name/content', (req, res) => {
    try {
      const skill = getSkill(req.params.name);
      if (!skill) {
        res.status(404).json({ error: `Skill not found: ${req.params.name}` });
        return;
      }
      const filePath = join(skill.path, 'SKILL.md');
      const content = readFileSync(filePath, 'utf-8');
      const stat = statSync(filePath);
      res.json({ content, lastModified: stat.mtime.toISOString() });
    } catch (err) {
      logger.error('Failed to read skill content', { error: String(err) });
      res.status(500).json({ error: 'Failed to read skill content' });
    }
  });

  // PUT /skills/:name/content — Write SKILL.md content
  router.put('/skills/:name/content', (req, res) => {
    const { content } = req.body ?? {};
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'Body must include a "content" string' });
      return;
    }
    try {
      const skill = getSkill(req.params.name);
      if (!skill) {
        res.status(404).json({ error: `Skill not found: ${req.params.name}` });
        return;
      }
      const filePath = join(skill.path, 'SKILL.md');
      writeFileSync(filePath, content, 'utf-8');
      rebuildClaudeMd();
      res.json({ ok: true });
    } catch (err) {
      logger.error('Failed to write skill content', { error: String(err) });
      res.status(500).json({ error: 'Failed to write skill content' });
    }
  });

  // POST /skills — Create a new skill
  router.post('/skills', (req, res) => {
    const { name, description, requiresEnv, hasSetup } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!description || typeof description !== 'string') {
      res.status(400).json({ error: 'description is required' });
      return;
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
      res.status(400).json({ error: 'name must be kebab-case (lowercase letters, numbers, hyphens)' });
      return;
    }
    try {
      const path = scaffoldSkill({ name, description, requiresEnv, hasSetup });
      rebuildClaudeMd();
      const skill = getSkill(name);
      res.json({ ok: true, path, skill });
    } catch (err: unknown) {
      const message = (err as Error).message || '';
      if (message.includes('already exists')) {
        res.status(409).json({ error: `Skill already exists: ${name}` });
        return;
      }
      logger.error('Failed to create skill', { error: String(err) });
      res.status(500).json({ error: 'Failed to create skill' });
    }
  });

  // DELETE /skills/:name — Remove a skill
  router.delete('/skills/:name', (req, res) => {
    try {
      const removed = removeSkill(req.params.name);
      if (!removed) {
        res.status(404).json({ error: `Skill not found: ${req.params.name}` });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error('Failed to remove skill', { error: String(err) });
      res.status(500).json({ error: 'Failed to remove skill' });
    }
  });

  // POST /skills/rebuild — Rebuild CLAUDE.md
  router.post('/skills/rebuild', (_req, res) => {
    try {
      rebuildClaudeMd();
      res.json({ ok: true });
    } catch (err) {
      logger.error('Failed to rebuild CLAUDE.md', { error: String(err) });
      res.status(500).json({ error: 'Failed to rebuild CLAUDE.md' });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // Agents
  // ─────────────────────────────────────────────────────────────────

  // GET /agents — List all installed agents
  router.get('/agents', (_req, res) => {
    try {
      const agents = loadInstalledAgents();
      res.json({ agents });
    } catch (err) {
      logger.error('Failed to list agents', { error: String(err) });
      res.status(500).json({ error: 'Failed to list agents' });
    }
  });

  // GET /agents/:name — Get a specific agent
  router.get('/agents/:name', (req, res) => {
    try {
      const agent = getAgent(req.params.name);
      if (!agent) {
        res.status(404).json({ error: `Agent not found: ${req.params.name}` });
        return;
      }
      res.json(agent);
    } catch (err) {
      logger.error('Failed to get agent', { error: String(err) });
      res.status(500).json({ error: 'Failed to get agent' });
    }
  });

  // GET /agents/:name/content — Read agent .md file content
  router.get('/agents/:name/content', (req, res) => {
    try {
      const agent = getAgent(req.params.name);
      if (!agent) {
        res.status(404).json({ error: `Agent not found: ${req.params.name}` });
        return;
      }
      const content = readFileSync(agent.path, 'utf-8');
      const stat = statSync(agent.path);
      res.json({ content, lastModified: stat.mtime.toISOString() });
    } catch (err) {
      logger.error('Failed to read agent content', { error: String(err) });
      res.status(500).json({ error: 'Failed to read agent content' });
    }
  });

  // PUT /agents/:name/content — Write agent .md file content
  router.put('/agents/:name/content', (req, res) => {
    const { content } = req.body ?? {};
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'Body must include a "content" string' });
      return;
    }
    try {
      const agent = getAgent(req.params.name);
      if (!agent) {
        res.status(404).json({ error: `Agent not found: ${req.params.name}` });
        return;
      }
      writeFileSync(agent.path, content, 'utf-8');
      rebuildClaudeMd();
      res.json({ ok: true });
    } catch (err) {
      logger.error('Failed to write agent content', { error: String(err) });
      res.status(500).json({ error: 'Failed to write agent content' });
    }
  });

  // POST /agents — Create a new agent
  router.post('/agents', (req, res) => {
    const { name, description, role, model, maxTurns, allowedTools } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!description || typeof description !== 'string') {
      res.status(400).json({ error: 'description is required' });
      return;
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
      res.status(400).json({ error: 'name must be kebab-case (lowercase letters, numbers, hyphens)' });
      return;
    }
    if (model && !['haiku', 'sonnet', 'opus'].includes(model)) {
      res.status(400).json({ error: 'model must be one of: haiku, sonnet, opus' });
      return;
    }
    try {
      const path = scaffoldAgent({ name, description, role, model, maxTurns, allowedTools });
      rebuildClaudeMd();
      const agent = getAgent(name);
      res.json({ ok: true, path, agent });
    } catch (err: unknown) {
      const message = (err as Error).message || '';
      if (message.includes('already exists')) {
        res.status(409).json({ error: `Agent already exists: ${name}` });
        return;
      }
      logger.error('Failed to create agent', { error: String(err) });
      res.status(500).json({ error: 'Failed to create agent' });
    }
  });

  // DELETE /agents/:name — Remove an agent
  router.delete('/agents/:name', (req, res) => {
    try {
      const removed = removeAgent(req.params.name);
      if (!removed) {
        res.status(404).json({ error: `Agent not found: ${req.params.name}` });
        return;
      }
      rebuildClaudeMd();
      res.json({ ok: true });
    } catch (err) {
      logger.error('Failed to remove agent', { error: String(err) });
      res.status(500).json({ error: 'Failed to remove agent' });
    }
  });

  // POST /agents/:name/spawn — Spawn agent with SSE streaming
  router.post('/agents/:name/spawn', asyncHandler(async (req, res) => {
    const name = req.params.name as string;
    const agent = getAgent(name);
    if (!agent) {
      res.status(404).json({ error: `Agent not found: ${name}` });
      return;
    }

    const { prompt } = req.body ?? {};
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendEvent = (event: string, data: unknown) => {
      if (!res.writableEnded) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    sendEvent('init', { agent: agent.name, model: agent.model });

    const root = getRoot();
    const systemPrompt = buildSystemPrompt(agent);
    const model = agent.model || getClaudeModel();

    // Spawn claude subprocess with stream-json output
    const args = [
      '--print', '-',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--max-turns', String(agent.maxTurns),
      '--system-prompt', systemPrompt,
    ];

    const proc = spawn('claude', args, {
      cwd: root,
      env: { ...process.env, KYBERBOT_ROOT: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const startTime = Date.now();

    // Write the prompt to stdin and close
    proc.stdin.write(prompt);
    proc.stdin.end();

    // Keepalive timer
    const keepalive = setInterval(() => {
      sendEvent('keepalive', {});
    }, 15_000);

    // Parse stream-json output
    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          switch (event.type) {
            case 'assistant':
              if (event.message?.content) {
                for (const block of event.message.content) {
                  if (block.type === 'text') {
                    sendEvent('text', { text: block.text });
                  } else if (block.type === 'tool_use') {
                    sendEvent('tool_start', {
                      id: block.id,
                      name: block.name,
                      label: block.name,
                      detail: JSON.stringify(block.input).slice(0, 200),
                    });
                  }
                }
              }
              break;
            case 'result':
              sendEvent('result', {
                durationMs: Date.now() - startTime,
                usage: event.usage,
                costUsd: event.cost_usd,
              });
              break;
          }
        } catch {
          // Skip unparseable lines
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      logger.debug(`Agent ${agent.name} stderr: ${chunk.toString().trim()}`);
    });

    proc.on('close', (code) => {
      clearInterval(keepalive);
      if (code !== 0) {
        sendEvent('error', { message: `Agent exited with code ${code}` });
      }
      res.end();
    });

    proc.on('error', (err) => {
      clearInterval(keepalive);
      sendEvent('error', { message: err.message });
      res.end();
    });

    // Abort on client disconnect
    res.on('close', () => {
      clearInterval(keepalive);
      if (proc.exitCode === null) {
        proc.kill('SIGTERM');
      }
    });
  }));

  // ─────────────────────────────────────────────────────────────────
  // Channels
  // ─────────────────────────────────────────────────────────────────

  // GET /channels — List channel status
  router.get('/channels', (_req, res) => {
    try {
      const result = channels.map(c => ({
        name: c.name,
        connected: c.isConnected(),
        verified: (c as any).isVerified?.() ?? null,
      }));
      res.json({ channels: result });
    } catch (err) {
      logger.error('Failed to list channels', { error: String(err) });
      res.status(500).json({ error: 'Failed to list channels' });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // Heartbeat
  // ─────────────────────────────────────────────────────────────────

  // GET /heartbeat — Parsed heartbeat tasks + state
  router.get('/heartbeat', (_req, res) => {
    try {
      if (!existsSync(paths.heartbeat)) {
        res.status(404).json({ error: 'HEARTBEAT.md not found' });
        return;
      }

      const content = readFileSync(paths.heartbeat, 'utf-8');
      const stat = statSync(paths.heartbeat);
      const tasks = parseHeartbeatTasks(content);

      // Read heartbeat state for last-run timestamps
      let state: Record<string, string> = {};
      if (existsSync(paths.heartbeatState)) {
        try {
          const raw = JSON.parse(readFileSync(paths.heartbeatState, 'utf-8'));
          state = raw.lastChecks || {};
        } catch {
          // Corrupt state file, ignore
        }
      }

      // Merge state into tasks
      const enrichedTasks = tasks.map(t => ({
        ...t,
        lastRun: state[t.name] || null,
      }));

      res.json({
        tasks: enrichedTasks,
        lastModified: stat.mtime.toISOString(),
        rawContent: content,
      });
    } catch (err) {
      logger.error('Failed to read heartbeat', { error: String(err) });
      res.status(500).json({ error: 'Failed to read heartbeat' });
    }
  });

  // PUT /heartbeat — Write HEARTBEAT.md content
  router.put('/heartbeat', (req, res) => {
    const { content } = req.body ?? {};
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'Body must include a "content" string' });
      return;
    }
    try {
      writeFileSync(paths.heartbeat, content, 'utf-8');
      res.json({ ok: true });
    } catch (err) {
      logger.error('Failed to write heartbeat', { error: String(err) });
      res.status(500).json({ error: 'Failed to write heartbeat' });
    }
  });

  // GET /heartbeat/log — Tail heartbeat log
  router.get('/heartbeat/log', (req, res) => {
    try {
      const maxLines = Math.min(parseInt(req.query.lines as string || '50') || 50, 500);

      if (!existsSync(paths.heartbeatLog)) {
        res.json({ content: '', exists: false });
        return;
      }

      const full = readFileSync(paths.heartbeatLog, 'utf-8');
      const lines = full.split('\n');
      const tail = lines.slice(-maxLines).join('\n');

      res.json({ content: tail, exists: true });
    } catch (err) {
      logger.error('Failed to read heartbeat log', { error: String(err) });
      res.status(500).json({ error: 'Failed to read heartbeat log' });
    }
  });

  return router;
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

interface HeartbeatTask {
  name: string;
  schedule: string;
  action: string;
  skill: string | null;
  window: string | null;
}

/**
 * Parse tasks from HEARTBEAT.md content.
 * Tasks are ### headers within the ## Tasks section.
 */
function parseHeartbeatTasks(content: string): HeartbeatTask[] {
  // Find the "## Tasks" section
  const tasksMatch = content.match(/## Tasks\s*\n([\s\S]*?)(?=\n---|\n## [^#]|$)/);
  if (!tasksMatch) return [];

  const tasksSection = tasksMatch[1];
  const taskBlocks = tasksSection.split(/(?=^### )/m).filter(b => b.trim().startsWith('### '));

  return taskBlocks.map(block => {
    const nameMatch = block.match(/^### (.+)/m);
    const name = nameMatch?.[1]?.trim() || 'Unknown';

    const scheduleMatch = block.match(/\*\*(?:Schedule|Cadence)\*\*:\s*(.+)/i);
    const schedule = scheduleMatch?.[1]?.trim() || '';

    const actionMatch = block.match(/\*\*Action\*\*:\s*([\s\S]*?)(?=\n\*\*|\n###|\n---|$)/i);
    const action = actionMatch?.[1]?.trim() || '';

    const skillMatch = block.match(/\*\*Skill\*\*:\s*(\S+)/i);
    const skill = skillMatch?.[1]?.trim() || null;

    const windowMatch = block.match(/\*\*Window\*\*:\s*(.+)/i);
    const window = windowMatch?.[1]?.trim() || null;

    return { name, schedule, action, skill, window };
  });
}
