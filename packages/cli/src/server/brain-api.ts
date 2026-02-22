/**
 * KyberBot — Brain REST API
 *
 * REST routes for querying and managing the brain.
 */

import { Router, Request, Response } from 'express';
import { getRoot } from '../config.js';
import { searchEntities, getEntityContext, getEntityGraphStats } from '../brain/entity-graph.js';
import { queryTimeline, getTimelineStats } from '../brain/timeline.js';
import { createLogger } from '../logger.js';

const logger = createLogger('brain-api');

export function createBrainRouter(): Router {
  const router = Router();

  // Health check
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Search entities
  router.get('/entities', async (req: Request, res: Response) => {
    try {
      const root = getRoot();
      const query = req.query.q as string || '';
      const type = req.query.type as string | undefined;
      const limit = parseInt(req.query.limit as string || '20');

      const results = await searchEntities(root, query, {
        type: type as any,
        limit,
      });
      res.json({ results });
    } catch (error) {
      logger.error('Entity search failed', { error: String(error) });
      res.status(500).json({ error: 'Search failed' });
    }
  });

  // Get entity context
  router.get('/entities/:nameOrId', async (req: Request, res: Response) => {
    try {
      const root = getRoot();
      const param = req.params.nameOrId as string;
      const nameOrId: string | number = /^\d+$/.test(param) ? parseInt(param) : param;

      const context = await getEntityContext(root, nameOrId);
      if (!context) {
        res.status(404).json({ error: 'Entity not found' });
        return;
      }
      res.json(context);
    } catch (error) {
      logger.error('Entity context fetch failed', { error: String(error) });
      res.status(500).json({ error: 'Fetch failed' });
    }
  });

  // Entity stats
  router.get('/entities-stats', async (_req: Request, res: Response) => {
    try {
      const root = getRoot();
      const stats = await getEntityGraphStats(root);
      res.json(stats);
    } catch (error) {
      logger.error('Entity stats failed', { error: String(error) });
      res.status(500).json({ error: 'Stats failed' });
    }
  });

  // Query timeline
  router.get('/timeline', async (req: Request, res: Response) => {
    try {
      const root = getRoot();
      const events = await queryTimeline(root, {
        start: req.query.start as string,
        end: req.query.end as string,
        type: req.query.type as any,
        search: req.query.q as string,
        limit: parseInt(req.query.limit as string || '50'),
      });
      res.json({ events });
    } catch (error) {
      logger.error('Timeline query failed', { error: String(error) });
      res.status(500).json({ error: 'Query failed' });
    }
  });

  // Timeline stats
  router.get('/timeline-stats', async (_req: Request, res: Response) => {
    try {
      const root = getRoot();
      const stats = await getTimelineStats(root);
      res.json(stats);
    } catch (error) {
      logger.error('Timeline stats failed', { error: String(error) });
      res.status(500).json({ error: 'Stats failed' });
    }
  });

  // Search brain (hybrid)
  router.post('/search', async (req: Request, res: Response) => {
    try {
      const { query, limit, tier, minPriority } = req.body;
      if (!query) {
        res.status(400).json({ error: 'Query required' });
        return;
      }
      // Hybrid search would be called here if ChromaDB is available
      res.json({ query, results: [], message: 'Hybrid search requires ChromaDB' });
    } catch (error) {
      logger.error('Brain search failed', { error: String(error) });
      res.status(500).json({ error: 'Search failed' });
    }
  });

  return router;
}
