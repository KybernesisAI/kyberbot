/**
 * KyberBot — Fleet Manager
 *
 * Orchestrates multiple AgentRuntime instances in a single Node.js process.
 * One Express server, one port, agent-namespaced routes.
 */

import express from 'express';
import http from 'http';
import { existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../logger.js';
import { getIdentityForRoot } from '../config.js';
import { loadRegistry } from '../registry.js';
import { AgentRuntime, AgentRuntimeStatus } from './agent-runtime.js';
import { AgentBus, setActiveBus } from './agent-bus.js';
import { FleetSleepScheduler } from './fleet-sleep-scheduler.js';
import { createFleetAuthMiddleware } from './fleet-auth.js';
import { getMetrics, errorMiddleware } from '../monitoring.js';
import { startTunnel, getTunnelUrl } from '../services/tunnel.js';
import { ServiceHandle } from '../types.js';
import { mountWebUi } from '../server/agent-router.js';
import { createOrchestrationRouter } from '../server/orchestration-api.js';

const logger = createLogger('fleet');

export class FleetManager {
  private agents = new Map<string, AgentRuntime>();
  private server: http.Server | null = null;
  private app: express.Express | null = null;
  private sleepScheduler: FleetSleepScheduler | null = null;
  private agentServers: http.Server[] = [];
  private tunnelHandles = new Map<string, ServiceHandle>();
  private bus: AgentBus;
  private startedAt = 0;

  constructor() {
    this.bus = new AgentBus();
    setActiveBus(this.bus);
  }

  /**
   * Load agents from registry.
   * If names is provided, loads only those agents. Otherwise loads auto_start or all.
   */
  async loadAgents(names?: string[]): Promise<void> {
    const registry = loadRegistry();
    const allNames = Object.keys(registry.agents);

    if (allNames.length === 0) {
      throw new Error('No agents registered. Run `kyberbot fleet register` first.');
    }

    const toLoad = names || registry.defaults?.auto_start || allNames;

    for (const name of toLoad) {
      const entry = registry.agents[name];
      if (!entry) {
        throw new Error(`Agent "${name}" not found in registry.`);
      }

      // Skip remote agents — they're handled separately
      if (entry.type === 'remote' || !entry.root) continue;

      // Skip agents whose directory was moved/renamed/deleted
      if (!existsSync(entry.root) || !existsSync(join(entry.root, 'identity.yaml'))) {
        logger.warn(`Skipping agent "${name}" — directory not found: ${entry.root}`);
        continue;
      }

      const identity = getIdentityForRoot(entry.root);
      const runtime = new AgentRuntime({
        root: entry.root,
        name,
        identity,
        bus: this.bus,
      });

      this.agents.set(name, runtime);
      logger.info(`Loaded agent: ${name}`, { root: entry.root });
    }

    // Load remote agents into the bus
    for (const [name, entry] of Object.entries(registry.agents)) {
      if (entry.type === 'remote' && entry.remoteUrl) {
        if (toLoad.includes(name) || !names) {
          this.bus.registerRemoteAgent(name, entry.remoteUrl, entry.remoteToken || '');
          logger.info(`Loaded remote agent: ${name}`, { url: entry.remoteUrl });
        }
      }
    }
  }

  /**
   * Start all loaded agents and the shared server.
   */
  async start(port: number = 3456): Promise<void> {
    this.startedAt = Date.now();

    // Start each agent's services (heartbeat, channels, embeddings)
    for (const [name, agent] of this.agents) {
      try {
        await agent.start();
      } catch (error) {
        logger.error(`Failed to start agent ${name}`, { error: String(error) });
      }
    }

    // Build auth lookup
    const authMap = new Map<string, { root: string; apiToken: string }>();
    for (const [name, agent] of this.agents) {
      authMap.set(name, { root: agent.root, apiToken: agent.apiToken });
    }

    // Create Express server
    this.app = express();
    this.app.use(express.json());

    // Fleet-level routes (no auth required for health)
    this.app.get('/health', (_req, res) => {
      const metrics = getMetrics();
      const statuses = this.getAllStatuses();
      const allHealthy = statuses.every(s => s.status === 'running');

      res.json({
        status: allHealthy ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: metrics.uptime_human,
        mode: 'fleet',
        agents: statuses.map(s => ({
          name: s.name,
          status: s.status,
          services: s.services,
        })),
        sleep: {
          currentAgent: this.sleepScheduler?.getCurrentAgent() || null,
          running: this.sleepScheduler?.isRunning() || false,
        },
        memory: metrics.memory,
        pid: metrics.pid,
      });
    });

    this.app.get('/fleet', (_req, res) => {
      const uptimeMs = Date.now() - this.startedAt;
      const uptimeSec = Math.floor(uptimeMs / 1000);
      const h = Math.floor(uptimeSec / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      const uptimeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;

      const statuses = this.getAllStatuses();

      // Include remote agents in fleet status
      const remoteAgentStatuses = this.bus.getRemoteAgentNames().map(name => {
          const config = this.bus.getRemoteAgentConfig(name);
          return {
            name,
            status: config?.online ? 'running' : 'unreachable',
            type: 'remote',
            uptime: '',
            services: [],
            channels: [],
            url: config?.baseUrl || '',
          };
        });

        res.json({
          mode: 'fleet',
          agents: [
            ...statuses.map(s => ({
              name: s.name,
              status: s.status,
              uptime: `${Math.floor(s.uptime / 1000)}s`,
              services: [
                { name: 'ChromaDB', status: s.services.embeddings === 'running' ? 'running' : 'disabled' },
                { name: 'Server', status: s.status },
                { name: 'Heartbeat', status: s.services.heartbeat },
                { name: 'Sleep Agent', status: this.sleepScheduler?.isRunning() ? 'running' : 'disabled' },
                { name: 'Channels', status: s.services.channels.length > 0 ? 'running' : 'disabled' },
                { name: 'Tunnel', status: this.tunnelHandles.has(s.name) ? 'running' : (this.agents.get(s.name)?.identity.tunnel?.enabled ? 'stopped' : 'disabled') },
              ],
              channels: s.services.channels,
            })),
            ...remoteAgentStatuses,
          ],
          sleep: {
            current_agent: this.sleepScheduler?.getCurrentAgent() || null,
            last_run: null,
          },
          uptime: uptimeStr,
          pid: process.pid,
        });
    });

    // Fleet management API
    this.app.post('/fleet/agents', express.json(), async (req, res) => {
      const { name, root } = req.body;
      if (!name || !root) {
        return res.status(400).json({ error: 'Missing name or root' });
      }
      try {
        await this.addAgent(name, root);
        res.json({ ok: true, agent: this.getAgentStatus(name) });
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    this.app.delete('/fleet/agents/:name', async (req, res) => {
      try {
        await this.removeAgent(req.params.name);
        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    // ── Bus API ──────────────────────────────────────────────────────────

    // POST /fleet/bus/send — send message between agents
    this.app.post('/fleet/bus/send', express.json(), async (req, res) => {
      const { from, to, message, topic } = req.body;
      if (!from || !to || !message) {
        return res.status(400).json({ error: 'Missing from, to, or message' });
      }
      try {
        const result = await this.bus.send({ from, to, type: 'query', payload: message, topic });
        res.json({ ok: true, response: result });
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    // POST /fleet/bus/broadcast — broadcast to all agents
    this.app.post('/fleet/bus/broadcast', express.json(), async (req, res) => {
      const { from, message, topic } = req.body;
      if (!from || !message) {
        return res.status(400).json({ error: 'Missing from or message' });
      }
      try {
        await this.bus.send({ from, to: '*', type: 'notify', payload: message, topic });
        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    // GET /fleet/bus/history — message history
    this.app.get('/fleet/bus/history', (req, res) => {
      const limit = parseInt(req.query.limit as string) || 50;
      const agent = req.query.agent as string;
      let history = this.bus.getHistory(limit);
      if (agent) {
        history = history.filter(m => m.from === agent || m.to === agent);
      }
      res.json({ messages: history });
    });

    // ── Orchestration API ───────────────────────────────────────────
    // Pass agent identities so the orch API can serve role/description data
    const agentIdentities = new Map<string, { name: string; description: string; root: string }>();
    for (const [name, agent] of this.agents) {
      agentIdentities.set(name, {
        name: agent.identity.agent_name || name,
        description: agent.identity.agent_description || '',
        root: agent.root,
      });
    }
    this.app.use('/fleet/orch', createOrchestrationRouter(agentIdentities));
    logger.info('Orchestration API mounted at /fleet/orch');

    // Mount web UI BEFORE auth — browsers don't send Bearer tokens on page loads
    mountWebUi(this.app, ''); // root UI
    for (const [name] of this.agents) {
      mountWebUi(this.app, `/agent/${name}`); // per-agent UI
    }

    // Per-agent routes with auth
    const fleetAuth = createFleetAuthMiddleware(authMap);

    for (const [name, agent] of this.agents) {
      this.app.use(`/agent/${name}`, fleetAuth, agent.createRouter());
    }

    // Mount first agent at root too — needed for:
    // 1. Single-agent backward compat
    // 2. Desktop app before fleet mode is detected (fetches root URLs initially)
    const firstAgent = [...this.agents.values()][0];
    if (firstAgent) {
      this.app.use('/', fleetAuth, firstAgent.createRouter());
    }

    // Error middleware
    this.app.use(errorMiddleware);

    // Start server
    this.server = http.createServer(this.app);
    await new Promise<void>((resolve) => {
      this.server!.listen(port, () => {
        logger.info(`Fleet server listening on port ${port}`);
        logger.info(`Agents: ${[...this.agents.keys()].join(', ')}`);

        if (this.agents.size === 1) {
          logger.info('Single-agent mode — root routes available');
        } else {
          logger.info('Multi-agent mode — use /agent/{name}/* routes');
        }

        resolve();
      });
    });

    // Start per-agent port listeners (so existing tunnel URLs keep working)
    for (const [name, agent] of this.agents) {
      const agentPort = agent.identity.server?.port;
      if (!agentPort || agentPort === port) continue; // skip if same as fleet port

      try {
        const agentApp = express();
        agentApp.use(express.json());

        // Public health endpoint (no auth — matches single-agent behavior)
        agentApp.get('/health', (_req, res) => {
          const s = agent.getStatus();
          res.json({
            status: s.status === 'running' ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            uptime: `${Math.floor(s.uptime / 1000)}s`,
            channels: s.services.channels,
            services: [
              { name: 'ChromaDB', status: s.services.embeddings === 'running' ? 'running' : 'disabled' },
              { name: 'Server', status: s.status },
              { name: 'Heartbeat', status: s.services.heartbeat },
              { name: 'Sleep Agent', status: this.sleepScheduler?.isRunning() ? 'running' : 'disabled' },
              { name: 'Channels', status: s.services.channels.length > 0 ? 'running' : 'disabled' },
              { name: 'Tunnel', status: this.tunnelHandles.has(name) ? 'running' : (agent.identity.tunnel?.enabled ? 'stopped' : 'disabled') },
            ],
            errors: 0,
            memory: {},
            pid: process.pid,
            node_version: process.version,
          });
        });

        // Web UI before auth
        mountWebUi(agentApp, '');

        // Single-agent auth for this port
        const singleAuth = createFleetAuthMiddleware(
          new Map([[name, { root: agent.root, apiToken: agent.apiToken }]])
        );
        agentApp.use('/', singleAuth, agent.createRouter());
        agentApp.use(errorMiddleware);

        const agentServer = http.createServer(agentApp);
        agentServer.listen(agentPort, () => {
          logger.info(`Agent ${name} also listening on port ${agentPort}`);
        });
        this.agentServers.push(agentServer);
      } catch (error) {
        logger.warn(`Could not bind agent ${name} to port ${agentPort}`, { error: String(error) });
      }
    }

    // Start tunnels for agents that have them configured
    for (const [name, agent] of this.agents) {
      if (!agent.identity.tunnel?.enabled) continue;
      const tunnelPort = agent.identity.server?.port || port;
      try {
        const handle = await startTunnel(tunnelPort);
        this.tunnelHandles.set(name, handle);
        const url = getTunnelUrl();
        logger.info(`Tunnel started for ${name}`, { port: tunnelPort, url });
      } catch (error) {
        logger.warn(`Tunnel failed for ${name}`, { error: String(error) });
      }
      // Only start one tunnel at a time (ngrok free tier limitation)
      // Future: support multiple tunnels with paid ngrok
      break;
    }

    // Register fleet connection with remote agents (so they can send bus messages back)
    const fleetTunnelUrl = getTunnelUrl();
    if (fleetTunnelUrl && this.bus.getRemoteAgentNames().length > 0) {
      const firstLocalAgent = [...this.agents.values()][0];
      const fleetToken = firstLocalAgent?.apiToken || '';

      for (const remoteName of this.bus.getRemoteAgentNames()) {
        const remote = this.bus.getRemoteAgentConfig(remoteName);
        if (!remote) continue;
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (remote.apiToken) headers['Authorization'] = `Bearer ${remote.apiToken}`;
          await fetch(`${remote.baseUrl}/api/bus/register-fleet`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ fleetUrl: fleetTunnelUrl, fleetToken }),
            signal: AbortSignal.timeout(10_000),
          });
          logger.info(`Fleet registered with remote agent ${remoteName}`, { fleetUrl: fleetTunnelUrl });
        } catch (error) {
          logger.warn(`Failed to register fleet with ${remoteName}`, { error: String(error) });
        }
      }
    }

    // Start sleep scheduler
    const sleepRoots = new Map<string, string>();
    for (const [name, agent] of this.agents) {
      sleepRoots.set(name, agent.root);
    }
    this.sleepScheduler = new FleetSleepScheduler(sleepRoots);
    // Start in background (don't await — it runs indefinitely)
    this.sleepScheduler.start().catch((err) =>
      logger.error('Sleep scheduler error', { error: String(err) })
    );

    // Health-check remote agents every 30 seconds
    if (this.bus.getRemoteAgentNames().length > 0) {
      const checkRemoteHealth = async () => {
        for (const name of this.bus.getRemoteAgentNames()) {
          const config = this.bus.getRemoteAgentConfig(name);
          if (!config) continue;
          try {
            const headers: Record<string, string> = { 'ngrok-skip-browser-warning': 'true' };
            if (config.apiToken) headers['Authorization'] = `Bearer ${config.apiToken}`;
            const res = await fetch(`${config.baseUrl}/health`, {
              headers,
              signal: AbortSignal.timeout(5000),
            });
            config.online = res.ok;
          } catch {
            config.online = false;
          }
        }
      };
      checkRemoteHealth();
      setInterval(checkRemoteHealth, 30_000);
    }

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down fleet...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  /**
   * Stop everything.
   */
  async stop(): Promise<void> {
    // Stop sleep scheduler
    if (this.sleepScheduler) {
      this.sleepScheduler.stop();
      this.sleepScheduler = null;
    }

    // Stop all agents
    for (const [name, agent] of this.agents) {
      try {
        await agent.stop();
      } catch (error) {
        logger.error(`Failed to stop agent ${name}`, { error: String(error) });
      }
    }

    // Stop tunnels
    for (const [name, handle] of this.tunnelHandles) {
      try { await handle.stop(); } catch {}
    }
    this.tunnelHandles.clear();

    // Stop per-agent servers
    for (const agentServer of this.agentServers) {
      await new Promise<void>((resolve) => {
        agentServer.close(() => resolve());
      });
    }
    this.agentServers = [];

    // Stop fleet server
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((err) => (err ? reject(err) : resolve()));
      });
      this.server = null;
    }

    setActiveBus(null);
    logger.info('Fleet stopped');
  }

  /**
   * Hot-add an agent to the running fleet.
   */
  async addAgent(name: string, root: string): Promise<void> {
    if (this.agents.has(name)) {
      throw new Error(`Agent "${name}" is already running`);
    }

    const identity = getIdentityForRoot(root);
    const runtime = new AgentRuntime({
      root,
      name,
      identity,
      bus: this.bus,
    });

    await runtime.start();
    this.agents.set(name, runtime);

    // Add route
    if (this.app) {
      const authMap = new Map<string, { root: string; apiToken: string }>();
      authMap.set(name, { root, apiToken: runtime.apiToken });
      this.app.use(`/agent/${name}`, createFleetAuthMiddleware(authMap), runtime.createRouter());
    }

    // Add to sleep scheduler
    if (this.sleepScheduler) {
      this.sleepScheduler.addAgent(name, root);
    }

    logger.info(`Hot-added agent: ${name}`);
  }

  /**
   * Hot-remove an agent from the running fleet.
   */
  async removeAgent(name: string): Promise<void> {
    const agent = this.agents.get(name);
    if (!agent) {
      throw new Error(`Agent "${name}" is not running`);
    }

    await agent.stop();
    this.agents.delete(name);

    // Remove from sleep scheduler
    if (this.sleepScheduler) {
      this.sleepScheduler.removeAgent(name);
    }

    // Note: Express doesn't support route removal, but the agent router
    // will return 404s since the agent is stopped. Acceptable for v1.

    logger.info(`Removed agent: ${name}`);
  }

  getAgentStatus(name: string): AgentRuntimeStatus | null {
    return this.agents.get(name)?.getStatus() || null;
  }

  getAllStatuses(): AgentRuntimeStatus[] {
    return [...this.agents.values()].map(a => a.getStatus());
  }

  getAgentNames(): string[] {
    return [...this.agents.keys()];
  }
}
