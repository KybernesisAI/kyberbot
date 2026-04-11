/**
 * KyberBot — Brain REST API
 *
 * REST routes for querying and managing the brain.
 */

import { Router, Request, Response } from 'express';
import { searchEntities, getEntityContext, getEntityGraphStats, getEntityGraphDb } from '../brain/entity-graph.js';
import { queryTimeline, getTimelineStats } from '../brain/timeline.js';
import { hybridSearch } from '../brain/hybrid-search.js';
import { createLogger } from '../logger.js';

const logger = createLogger('brain-api');

export function createBrainRouter(root: string): Router {
  const router = Router();

  // Health check
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Search entities
  router.get('/entities', async (req: Request, res: Response) => {
    try {
      const query = req.query.q as string || '';
      const type = req.query.type as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string || '20') || 20, 500);

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
      const events = await queryTimeline(root, {
        start: req.query.start as string,
        end: req.query.end as string,
        type: req.query.type as any,
        search: req.query.q as string,
        limit: Math.min(parseInt(req.query.limit as string || '50') || 50, 500),
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
      const stats = await getTimelineStats(root);
      res.json(stats);
    } catch (error) {
      logger.error('Timeline stats failed', { error: String(error) });
      res.status(500).json({ error: 'Stats failed' });
    }
  });

  // Entity graph for visualization (p5.js canvas)
  router.get('/graph', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string || '100') || 100, 500);
      const entityId = req.query.entityId ? parseInt(req.query.entityId as string) : undefined;
      const types = req.query.types ? (req.query.types as string).split(',') : undefined;

      const db = await getEntityGraphDb(root);

      let nodes: unknown[];
      let nodeIds: Set<number>;

      if (entityId) {
        // 2-hop neighborhood around a specific entity
        const rows = db.prepare(`
          WITH hop1 AS (
            SELECT CASE WHEN source_id = ? THEN target_id ELSE source_id END AS id
            FROM entity_relations WHERE source_id = ? OR target_id = ?
          ),
          hop2 AS (
            SELECT CASE WHEN r.source_id = h.id THEN r.target_id ELSE r.source_id END AS id
            FROM entity_relations r JOIN hop1 h ON r.source_id = h.id OR r.target_id = h.id
          ),
          all_ids AS (
            SELECT ? AS id UNION SELECT id FROM hop1 UNION SELECT id FROM hop2
          )
          SELECT DISTINCT e.id, e.name, e.type, e.mention_count, COALESCE(e.priority, 0.5) AS priority,
                 COALESCE(e.decay_score, 0) AS decay_score, COALESCE(e.tier, 'warm') AS tier, e.last_seen
          FROM entities e JOIN all_ids a ON e.id = a.id
        `).all(entityId, entityId, entityId, entityId);
        nodes = rows;
      } else {
        // Top entities by mention count
        let sql = `SELECT id, name, type, mention_count, COALESCE(priority, 0.5) AS priority,
                   COALESCE(decay_score, 0) AS decay_score, COALESCE(tier, 'warm') AS tier, last_seen
                   FROM entities`;
        const params: unknown[] = [];

        if (types && types.length > 0) {
          sql += ` WHERE type IN (${types.map(() => '?').join(',')})`;
          params.push(...types);
        }

        sql += ' ORDER BY mention_count DESC LIMIT ?';
        params.push(limit);

        nodes = db.prepare(sql).all(...params);
      }

      nodeIds = new Set((nodes as any[]).map(n => n.id));

      // Get edges between the selected nodes
      let edges: unknown[] = [];
      if (nodeIds.size > 0) {
        const ids = [...nodeIds];
        const placeholders = ids.map(() => '?').join(',');
        edges = db.prepare(`
          SELECT source_id AS source, target_id AS target, relationship,
                 strength, COALESCE(confidence, 0.5) AS confidence
          FROM entity_relations
          WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders})
        `).all(...ids, ...ids);
      }

      res.json({ nodes, edges });
    } catch (error) {
      logger.error('Graph data fetch failed', { error: String(error) });
      res.status(500).json({ error: 'Graph fetch failed' });
    }
  });

  // Search brain (hybrid: semantic + keyword)
  router.post('/search', async (req: Request, res: Response) => {
    try {
      const { query, limit, tier, minPriority } = req.body;
      if (!query) {
        res.status(400).json({ error: 'Query required' });
        return;
      }
      const results = await hybridSearch(query, root, {
        limit: Math.min(parseInt(limit) || 20, 500),
        tier: tier || 'all',
        minPriority: parseFloat(minPriority) || 0,
      });
      res.json({ query, results });
    } catch (error) {
      logger.error('Brain search failed', { error: String(error) });
      res.status(500).json({ error: 'Search failed' });
    }
  });

  return router;
}
