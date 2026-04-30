/**
 * KyberBot — Management API
 *
 * REST endpoints for managing skills, agents, channels, and heartbeat.
 * Used by the KyberBot Desktop app and benefits the web UI too.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { readFileSync, writeFileSync, statSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { spawn } from 'node:child_process';
import yaml from 'js-yaml';
import { getClaudeModel } from '../config.js';
import { loadInstalledSkills, getSkill } from '../skills/loader.js';
import { scaffoldSkill } from '../skills/scaffolder.js';
import { removeSkill, rebuildClaudeMd } from '../skills/registry.js';
import { loadInstalledAgents, getAgent } from '../agents/loader.js';
import { scaffoldAgent } from '../agents/scaffolder.js';
import { removeAgent } from '../agents/registry.js';
import { buildSystemPrompt } from '../agents/spawner.js';
import { Channel } from './channels/types.js';
import { getTunnelUrl } from '../services/tunnel.js';
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

export function createManagementRouter(channels: Channel[], root: string): Router {
  const router = Router();

  // ─────────────────────────────────────────────────────────────────
  // Skills
  // ─────────────────────────────────────────────────────────────────

  // GET /skills — List all installed skills
  router.get('/skills', (_req, res) => {
    try {
      const skills = loadInstalledSkills(root);
      res.json({ skills });
    } catch (err) {
      logger.error('Failed to list skills', { error: String(err) });
      res.status(500).json({ error: 'Failed to list skills' });
    }
  });

  // GET /skills/:name — Get a specific skill
  router.get('/skills/:name', (req, res) => {
    try {
      const skill = getSkill(req.params.name, root);
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
      const skill = getSkill(req.params.name, root);
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
      const skill = getSkill(req.params.name, root);
      if (!skill) {
        res.status(404).json({ error: `Skill not found: ${req.params.name}` });
        return;
      }
      const filePath = join(skill.path, 'SKILL.md');
      writeFileSync(filePath, content, 'utf-8');
      rebuildClaudeMd(root);
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
      const path = scaffoldSkill({ name, description, requiresEnv, hasSetup }, root);
      rebuildClaudeMd(root);
      const skill = getSkill(name, root);
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
      const removed = removeSkill(req.params.name, root);
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
      rebuildClaudeMd(root);
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
      const agents = loadInstalledAgents(root);
      res.json({ agents });
    } catch (err) {
      logger.error('Failed to list agents', { error: String(err) });
      res.status(500).json({ error: 'Failed to list agents' });
    }
  });

  // GET /agents/:name — Get a specific agent
  router.get('/agents/:name', (req, res) => {
    try {
      const agent = getAgent(req.params.name, root);
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
      const agent = getAgent(req.params.name, root);
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
      const agent = getAgent(req.params.name, root);
      if (!agent) {
        res.status(404).json({ error: `Agent not found: ${req.params.name}` });
        return;
      }
      writeFileSync(agent.path, content, 'utf-8');
      rebuildClaudeMd(root);
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
      const path = scaffoldAgent({ name, description, role, model, maxTurns, allowedTools }, root);
      rebuildClaudeMd(root);
      const agent = getAgent(name, root);
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
      const removed = removeAgent(req.params.name, root);
      if (!removed) {
        res.status(404).json({ error: `Agent not found: ${req.params.name}` });
        return;
      }
      rebuildClaudeMd(root);
      res.json({ ok: true });
    } catch (err) {
      logger.error('Failed to remove agent', { error: String(err) });
      res.status(500).json({ error: 'Failed to remove agent' });
    }
  });

  // POST /agents/:name/spawn — Spawn agent with SSE streaming
  router.post('/agents/:name/spawn', asyncHandler(async (req, res) => {
    const name = req.params.name as string;
    const agent = getAgent(name, root);
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

    const systemPrompt = buildSystemPrompt(agent);
    const model = agent.model || getClaudeModel();

    // Spawn claude subprocess with stream-json output
    const args = [
      '--print', '-',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
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

  // GET /channels/config — Read channel config from identity.yaml
  router.get('/channels/config', (_req, res) => {
    try {
      const identityPath = join(root, 'identity.yaml');
      const identity = yaml.load(readFileSync(identityPath, 'utf-8')) as Record<string, any>;
      res.json({ channels: identity.channels || {} });
    } catch (err) {
      logger.error('Failed to read channel config', { error: String(err) });
      res.status(500).json({ error: 'Failed to read channel config' });
    }
  });

  // POST /channels/:type — Add/configure a channel
  router.post('/channels/:type', (req, res) => {
    const type = req.params.type as string;
    if (!['telegram', 'whatsapp'].includes(type)) {
      res.status(400).json({ error: 'Channel type must be telegram or whatsapp' });
      return;
    }
    try {
      const identityPath = join(root, 'identity.yaml');
      const identity = yaml.load(readFileSync(identityPath, 'utf-8')) as Record<string, any>;
      if (!identity.channels) identity.channels = {};
      identity.channels[type] = req.body;
      writeFileSync(identityPath, yaml.dump(identity, { lineWidth: 120 }), 'utf-8');
      res.json({ ok: true });
    } catch (err) {
      logger.error('Failed to configure channel', { error: String(err) });
      res.status(500).json({ error: 'Failed to configure channel' });
    }
  });

  // DELETE /channels/:type — Remove a channel
  router.delete('/channels/:type', (req, res) => {
    const type = req.params.type as string;
    try {
      const identityPath = join(root, 'identity.yaml');
      const identity = yaml.load(readFileSync(identityPath, 'utf-8')) as Record<string, any>;
      if (identity.channels) {
        delete identity.channels[type];
        writeFileSync(identityPath, yaml.dump(identity, { lineWidth: 120 }), 'utf-8');
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error('Failed to remove channel', { error: String(err) });
      res.status(500).json({ error: 'Failed to remove channel' });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // Heartbeat
  // ─────────────────────────────────────────────────────────────────

  // GET /heartbeat — Parsed heartbeat tasks + state
  router.get('/heartbeat', (_req, res) => {
    try {
      if (!existsSync(join(root, 'HEARTBEAT.md'))) {
        res.status(404).json({ error: 'HEARTBEAT.md not found' });
        return;
      }

      const content = readFileSync(join(root, 'HEARTBEAT.md'), 'utf-8');
      const stat = statSync(join(root, 'HEARTBEAT.md'));
      const tasks = parseHeartbeatTasks(content);

      // Read heartbeat state for last-run timestamps
      let state: Record<string, string> = {};
      if (existsSync(join(root, 'heartbeat-state.json'))) {
        try {
          const raw = JSON.parse(readFileSync(join(root, 'heartbeat-state.json'), 'utf-8'));
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
      writeFileSync(join(root, 'HEARTBEAT.md'), content, 'utf-8');
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

      if (!existsSync(join(root, 'logs', 'heartbeat.log'))) {
        res.json({ content: '', exists: false });
        return;
      }

      const full = readFileSync(join(root, 'logs', 'heartbeat.log'), 'utf-8');
      const lines = full.split('\n');
      const tail = lines.slice(-maxLines).join('\n');

      res.json({ content: tail, exists: true });
    } catch (err) {
      logger.error('Failed to read heartbeat log', { error: String(err) });
      res.status(500).json({ error: 'Failed to read heartbeat log' });
    }
  });

  // POST /heartbeat/run — Manual heartbeat trigger
  router.post('/heartbeat/run', asyncHandler(async (_req, res) => {
    try {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync('kyberbot', ['heartbeat', 'run'], {
        cwd: root,
        env: { ...process.env, KYBERBOT_ROOT: root },
        encoding: 'utf-8',
        timeout: 60_000,
      });
      res.json({ ok: true, output: result.stdout, error: result.stderr });
    } catch (err) {
      logger.error('Failed to trigger heartbeat', { error: String(err) });
      res.status(500).json({ error: 'Failed to trigger heartbeat' });
    }
  }));

  // GET /tunnel — Tunnel status and URL
  router.get('/tunnel', async (_req, res) => {
    try {
      const url = getTunnelUrl();
      // Also try the ngrok local API as fallback
      let ngrokUrl = url;
      if (!ngrokUrl) {
        try {
          const response = await fetch('http://localhost:4040/api/tunnels', { signal: AbortSignal.timeout(2000) });
          if (response.ok) {
            const data = await response.json() as { tunnels: Array<{ public_url: string; proto: string }> };
            const https = data.tunnels?.find((t: any) => t.proto === 'https');
            ngrokUrl = https?.public_url ?? data.tunnels?.[0]?.public_url ?? null;
          }
        } catch { /* ngrok API not available */ }
      }
      res.json({ url: ngrokUrl, running: !!ngrokUrl });
    } catch (err) {
      res.json({ url: null, running: false });
    }
  });

  // GET /brain-notes — List all memory files across all storage locations
  router.get('/brain-notes', (_req, res) => {
    try {
      const allNotes: any[] = [];

      // Helper to scan a directory for .md files
      const scanDir = (dir: string, source: string) => {
        if (!existsSync(dir)) return;
        const files = readdirSync(dir).filter(f => f.endsWith('.md'));
        for (const f of files) {
          const filePath = join(dir, f);
          try {
            const stat = statSync(filePath);
            allNotes.push({
              name: f,
              path: filePath,
              size: stat.size,
              lastModified: stat.mtime.toISOString(),
              source,
            });
          } catch { /* skip unreadable files */ }
        }
      };

      // 1. brain/ directory (brain notes)
      scanDir(join(root, 'brain'), 'brain');

      // 2. Claude Code project memory files
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const claudeMemoryDir = join(homeDir, '.claude', 'projects', `-Users-${process.env.USER || 'user'}-${root.split('/').pop()}`, 'memory');
      scanDir(claudeMemoryDir, 'claude-memory');

      // 3. data/claude-memory/ synced files
      scanDir(join(root, 'data', 'claude-memory'), 'claude-sync');

      // 4. Root markdown files (SOUL.md, USER.md, HEARTBEAT.md)
      for (const f of ['SOUL.md', 'USER.md', 'HEARTBEAT.md']) {
        const filePath = join(root, f);
        if (existsSync(filePath)) {
          const stat = statSync(filePath);
          allNotes.push({ name: f, path: filePath, size: stat.size, lastModified: stat.mtime.toISOString(), source: 'identity' });
        }
      }

      // Sort by lastModified descending
      allNotes.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

      res.json({ notes: allNotes });
    } catch (err) {
      logger.error('Failed to list brain notes', { error: String(err) });
      res.status(500).json({ error: 'Failed to list brain notes' });
    }
  });

  // POST /brain-notes/read — Read a note file by full path
  router.post('/brain-notes/read', (req, res) => {
    try {
      const { path: filePath } = req.body;
      if (!filePath || !existsSync(filePath)) {
        res.status(404).json({ error: 'Note not found' });
        return;
      }
      const content = readFileSync(filePath, 'utf-8');
      const stat = statSync(filePath);
      res.json({ name: filePath.split('/').pop(), content, lastModified: stat.mtime.toISOString() });
    } catch (err) {
      logger.error('Failed to read brain note', { error: String(err) });
      res.status(500).json({ error: 'Failed to read brain note' });
    }
  });

  // POST /remember — Store a memory via the running server (avoids subprocess OOM).
  // ARP unification (Phase A.6): accepts an optional `metadata` field
  // carrying agent-resource attributes (project_id, tags, classification,
  // connection_id, source_did). Forwarded into storeConversation; the
  // brain layer stamps facts/timeline/sessions/ChromaDB accordingly.
  router.post('/remember', asyncHandler(async (req, res) => {
    const { text, response, channel, metadata } = req.body ?? {};
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    try {
      const { storeConversation } = await import('../brain/store-conversation.js');
      await storeConversation(root, {
        prompt: text,
        response: response || '',
        channel: channel || 'terminal',
        ...(metadata && typeof metadata === 'object' ? { metadata } : {}),
      });
      res.json({ ok: true });
    } catch (err) {
      logger.error('Remember failed', { error: String(err) });
      res.status(500).json({ error: 'Failed to store memory' });
    }
  }));

  // GET /logs/:service — Tail service-specific log
  router.get('/logs/:service', (req, res) => {
    try {
      const service = req.params.service as string;
      const maxLines = Math.min(parseInt(req.query.lines as string || '100') || 100, 500);

      // Map service names to log files
      const logFiles: Record<string, string> = {
        heartbeat: join(root, 'logs', 'heartbeat.log'),
        desktop: join(root, 'logs', 'desktop-cli.log'),
      };

      const logPath = logFiles[service];
      if (!logPath || !existsSync(logPath)) {
        res.json({ content: '', exists: false });
        return;
      }

      const full = readFileSync(logPath, 'utf-8');
      const lines = full.split('\n');
      const tail = lines.slice(-maxLines).join('\n');
      res.json({ content: tail, exists: true });
    } catch (err) {
      logger.error('Failed to read service log', { error: String(err) });
      res.status(500).json({ error: 'Failed to read service log' });
    }
  });

  // GET /watched-folders/status — Sync status for all watched folders
  router.get('/watched-folders/status', (_req, res) => {
    try {
      const { getWatchedFoldersStatus } = require('../services/watched-folders.js');
      res.json({ folders: getWatchedFoldersStatus(root) });
    } catch (err) {
      res.json({ folders: [] });
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
