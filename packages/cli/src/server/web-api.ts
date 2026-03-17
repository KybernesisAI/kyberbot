/**
 * KyberBot — Web API
 *
 * REST endpoints for the KyberBot web UI. Provides access to memory blocks,
 * identity configuration, conversations, and agent status.
 */

import { Router } from 'express';
import { readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { paths, getIdentity, getAgentName, getRoot, resetConfig } from '../config.js';
import { queryTimeline } from '../brain/timeline.js';
import { listSessions, getSessionMessages, createSession, saveMessage } from '../brain/messages.js';
import { createLogger } from '../logger.js';

const logger = createLogger('web-api');

const VALID_BLOCKS = ['soul', 'user', 'heartbeat'] as const;
type MemoryBlock = (typeof VALID_BLOCKS)[number];

function isValidBlock(block: string): block is MemoryBlock {
  return VALID_BLOCKS.includes(block as MemoryBlock);
}

function getBlockPath(block: MemoryBlock): string {
  return paths[block];
}

export function createWebApiRouter(): Router {
  const router = Router();

  // GET /memory/:block — Read a memory block (SOUL.md, USER.md, HEARTBEAT.md)
  router.get('/memory/:block', (req, res) => {
    const { block } = req.params;

    if (!isValidBlock(block)) {
      res.status(400).json({ error: `Invalid block: ${block}. Must be one of: ${VALID_BLOCKS.join(', ')}` });
      return;
    }

    try {
      const filePath = getBlockPath(block);
      const content = readFileSync(filePath, 'utf-8');
      const stat = statSync(filePath);
      res.json({ content, lastModified: stat.mtime.toISOString() });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        res.status(404).json({ error: `Memory block '${block}' not found` });
        return;
      }
      logger.error(`Failed to read memory block '${block}'`, { error: String(err) });
      res.status(500).json({ error: 'Failed to read memory block' });
    }
  });

  // PUT /memory/:block — Write a memory block
  router.put('/memory/:block', (req, res) => {
    const { block } = req.params;

    if (!isValidBlock(block)) {
      res.status(400).json({ error: `Invalid block: ${block}. Must be one of: ${VALID_BLOCKS.join(', ')}` });
      return;
    }

    const { content } = req.body ?? {};
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'Body must include a "content" string' });
      return;
    }

    try {
      const filePath = getBlockPath(block);
      writeFileSync(filePath, content, 'utf-8');
      res.json({ ok: true });
    } catch (err) {
      logger.error(`Failed to write memory block '${block}'`, { error: String(err) });
      res.status(500).json({ error: 'Failed to write memory block' });
    }
  });

  // GET /identity — Read identity.yaml as JSON
  router.get('/identity', (_req, res) => {
    try {
      resetConfig();
      const identity = getIdentity();
      res.json(identity);
    } catch (err) {
      logger.error('Failed to read identity', { error: String(err) });
      res.status(500).json({ error: 'Failed to read identity configuration' });
    }
  });

  // PUT /identity — Update identity.yaml fields
  router.put('/identity', (req, res) => {
    const changes = req.body;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      res.status(400).json({ error: 'Body must be a JSON object with fields to update' });
      return;
    }

    // Validation
    if (changes.heartbeat_interval && !/^\d+[mh]$/.test(changes.heartbeat_interval)) {
      res.status(400).json({ error: 'heartbeat_interval must match format like "30m" or "2h"' });
      return;
    }

    try {
      const root = getRoot();
      const identityPath = join(root, 'identity.yaml');
      const current = yaml.load(readFileSync(identityPath, 'utf-8')) as Record<string, unknown>;

      // Deep merge changes into current
      deepMerge(current, changes);

      writeFileSync(identityPath, yaml.dump(current, { lineWidth: 120 }), 'utf-8');
      resetConfig();

      logger.info('Identity updated via web UI', { fields: Object.keys(changes) });
      res.json({ ok: true });
    } catch (err) {
      logger.error('Failed to update identity', { error: String(err), stack: (err as Error).stack });
      res.status(500).json({ error: 'Failed to update identity configuration' });
    }
  });

  // GET /sessions — List recent chat sessions
  router.get('/sessions', (_req, res) => {
    try {
      const root = getRoot();
      const sessions = listSessions(root, 30);
      res.json({ sessions });
    } catch (err) {
      logger.error('Failed to list sessions', { error: String(err) });
      res.json({ sessions: [] });
    }
  });

  // POST /sessions — Create a new session
  router.post('/sessions', (req, res) => {
    try {
      const root = getRoot();
      const sessionId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createSession(root, sessionId, 'web');
      res.json({ sessionId });
    } catch (err) {
      logger.error('Failed to create session', { error: String(err) });
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  // GET /sessions/:id/messages — Get messages for a session
  router.get('/sessions/:id/messages', (req, res) => {
    try {
      const root = getRoot();
      const messages = getSessionMessages(root, req.params.id);
      res.json({
        messages: messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          toolCalls: m.tool_calls_json ? JSON.parse(m.tool_calls_json) : undefined,
          memoryUpdates: m.memory_updates_json ? JSON.parse(m.memory_updates_json) : undefined,
          usage: m.usage_json ? JSON.parse(m.usage_json) : undefined,
          costUsd: m.cost_usd,
          timestamp: new Date(m.created_at).getTime(),
        })),
      });
    } catch (err) {
      logger.error('Failed to get session messages', { error: String(err) });
      res.json({ messages: [] });
    }
  });

  // POST /sessions/:id/messages — Save a message to a session
  router.post('/sessions/:id/messages', (req, res) => {
    const { role, content, toolCalls, memoryUpdates, usage, costUsd } = req.body ?? {};
    if (!role || !content) {
      res.status(400).json({ error: 'role and content are required' });
      return;
    }
    try {
      const root = getRoot();
      const msgId = saveMessage(root, req.params.id, role, content, {
        toolCalls,
        memoryUpdates,
        usage,
        costUsd,
      });
      res.json({ id: msgId });
    } catch (err) {
      logger.error('Failed to save message', { error: String(err) });
      res.status(500).json({ error: 'Failed to save message' });
    }
  });

  // GET /status — Aggregate service status
  router.get('/status', (_req, res) => {
    try {
      const agent = getAgentName();
      res.json({
        agent,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.error('Failed to get status', { error: String(err) });
      res.status(500).json({ error: 'Failed to get status' });
    }
  });

  return router;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>, depth = 0): void {
  if (depth > 10) return;
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
        tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)) {
      deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>, depth + 1);
    } else {
      target[key] = srcVal;
    }
  }
}
