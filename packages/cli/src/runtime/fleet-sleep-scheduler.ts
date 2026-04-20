/**
 * KyberBot — Fleet Sleep Scheduler
 *
 * Instead of N independent sleep agents (one per agent), this scheduler
 * round-robins through all agents, running one sleep cycle at a time.
 * This prevents resource spikes from concurrent cycles.
 */

import { createLogger } from '../logger.js';
import { isStoreActive } from '../brain/store-conversation.js';
import { runSleepCycleNow } from '../brain/sleep/index.js';

const logger = createLogger('fleet-sleep');

export interface FleetSleepConfig {
  initialDelayMinutes: number;
  cycleGapSeconds: number;
  intervalMinutes: number;
}

const DEFAULT_CONFIG: FleetSleepConfig = {
  initialDelayMinutes: 5,
  cycleGapSeconds: 30,
  // Every 3 hours per-agent in fleet mode. See also brain/sleep/config.ts
  // DEFAULT_CONFIG.intervalMinutes — keep these aligned.
  intervalMinutes: 180,
};

export class FleetSleepScheduler {
  private agentRoots: Map<string, string>; // name → root
  private running = false;
  private currentAgent: string | null = null;
  private config: FleetSleepConfig;

  constructor(
    agentRoots: Map<string, string>,
    config: Partial<FleetSleepConfig> = {}
  ) {
    this.agentRoots = agentRoots;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async start(): Promise<void> {
    this.running = true;
    logger.info('Fleet sleep scheduler starting', {
      agents: [...this.agentRoots.keys()],
      interval: `${this.config.intervalMinutes}m`,
    });

    // Initial delay
    await this.sleep(this.config.initialDelayMinutes * 60 * 1000);

    while (this.running) {
      const cycleStart = Date.now();

      for (const [name, root] of this.agentRoots) {
        if (!this.running) break;

        this.currentAgent = name;
        logger.info(`Sleep cycle starting for ${name}`);

        // Wait for any active store on this agent
        let waited = 0;
        while (isStoreActive(root) && waited < 60_000) {
          await this.sleep(2000);
          waited += 2000;
        }

        try {
          const metrics = await runSleepCycleNow(root);
          logger.info(`Sleep cycle completed for ${name}`, {
            duration: `${Math.round(metrics.totalDurationMs / 1000)}s`,
          });
        } catch (error) {
          logger.error(`Sleep cycle failed for ${name}`, { error: String(error) });
        }

        this.currentAgent = null;

        // Gap between agents
        if (this.running) {
          await this.sleep(this.config.cycleGapSeconds * 1000);
        }
      }

      // Wait for remaining interval time
      const elapsed = Date.now() - cycleStart;
      const remaining = this.config.intervalMinutes * 60 * 1000 - elapsed;
      if (remaining > 0 && this.running) {
        await this.sleep(remaining);
      }
    }

    logger.info('Fleet sleep scheduler stopped');
  }

  stop(): void {
    this.running = false;
  }

  getCurrentAgent(): string | null {
    return this.currentAgent;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Add an agent to the rotation (hot-add).
   */
  addAgent(name: string, root: string): void {
    this.agentRoots.set(name, root);
    logger.info(`Added ${name} to sleep rotation`);
  }

  /**
   * Remove an agent from the rotation (hot-remove).
   */
  removeAgent(name: string): void {
    this.agentRoots.delete(name);
    logger.info(`Removed ${name} from sleep rotation`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Allow early exit if stopped
      const check = setInterval(() => {
        if (!this.running) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 1000);
    });
  }
}
