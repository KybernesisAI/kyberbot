import { existsSync, mkdirSync, watch } from "fs";
import { dirname } from "path";

export type DrainDetectionSource = "startup" | "watch" | "control-poll";
export type DrainWatcherState = "initializing" | "active" | "retrying";

export interface DrainControlSnapshot {
  control_poll_ms: number;
  watch_state: DrainWatcherState;
  last_watch_event_at: string | null;
  last_watch_error: string | null;
  last_drain_detection_source: DrainDetectionSource | null;
  last_drain_detection_at: string | null;
}

export interface DrainControlPlaneOptions {
  drainRequestFile: string;
  controlPollMs: number;
  onDrainRequested: (input: {
    source: DrainDetectionSource;
    detectedAt: string;
  }) => Promise<void> | void;
  onStateChange?: () => Promise<void> | void;
  log?: (message: string) => void;
  now?: () => Date;
  watchFactory?: (
    path: string,
    listener: (eventType: string, filename: string | Buffer | null) => void,
  ) => FSWatcherLike;
}

export interface DrainControlPlane {
  start(): Promise<void>;
  stop(): void;
  snapshot(): DrainControlSnapshot;
}

interface FSWatcherLike {
  close(): void;
  on(event: "error", listener: (error: Error) => void): FSWatcherLike;
}

export function createDrainControlPlane(
  options: DrainControlPlaneOptions,
): DrainControlPlane {
  const now = options.now ?? (() => new Date());
  const controlDir = dirname(options.drainRequestFile);
  const watchFactory = options.watchFactory ?? watch;

  let watcher: FSWatcherLike | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let lastDrainRequestPresent = false;
  let reconcileTail = Promise.resolve();

  let watchState: DrainWatcherState = "initializing";
  let lastWatchEventAt: string | null = null;
  let lastWatchError: string | null = null;
  let lastDrainDetectionSource: DrainDetectionSource | null = null;
  let lastDrainDetectionAt: string | null = null;

  function snapshot(): DrainControlSnapshot {
    return {
      control_poll_ms: options.controlPollMs,
      watch_state: watchState,
      last_watch_event_at: lastWatchEventAt,
      last_watch_error: lastWatchError,
      last_drain_detection_source: lastDrainDetectionSource,
      last_drain_detection_at: lastDrainDetectionAt,
    };
  }

  function emitStateChange(): void {
    if (!options.onStateChange) {
      return;
    }

    void Promise.resolve(options.onStateChange()).catch((error) => {
      options.log?.(
        `[dispatcher] drain control state update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  function setWatchState(nextState: DrainWatcherState, nextError: string | null): void {
    const changed = watchState !== nextState || lastWatchError !== nextError;
    watchState = nextState;
    lastWatchError = nextError;
    if (changed) {
      emitStateChange();
    }
  }

  function handleWatcherError(error: unknown): void {
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // Ignore close races.
      }
      watcher = null;
    }

    if (stopped) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const shouldLog = watchState !== "retrying" || lastWatchError !== message;
    setWatchState("retrying", message);
    if (shouldLog) {
      options.log?.(`[dispatcher] drain watcher unavailable: ${message}`);
    }
  }

  function ensureWatcher(): void {
    if (stopped || watcher) {
      return;
    }

    mkdirSync(controlDir, { recursive: true });

    try {
      const nextWatcher = watchFactory(controlDir, () => {
        lastWatchEventAt = now().toISOString();
        emitStateChange();
        queueReconcile("watch");
      });
      nextWatcher.on("error", (error) => {
        handleWatcherError(error);
      });
      watcher = nextWatcher;
      setWatchState("active", null);
    } catch (error) {
      handleWatcherError(error);
    }
  }

  async function reconcile(source: DrainDetectionSource): Promise<void> {
    if (stopped) {
      return;
    }

    const drainRequestPresent = existsSync(options.drainRequestFile);
    if (!drainRequestPresent) {
      lastDrainRequestPresent = false;
      return;
    }

    if (lastDrainRequestPresent) {
      return;
    }

    lastDrainRequestPresent = true;
    const detectedAt = now().toISOString();
    lastDrainDetectionSource = source;
    lastDrainDetectionAt = detectedAt;
    emitStateChange();

    try {
      await options.onDrainRequested({
        source,
        detectedAt,
      });
    } catch (error) {
      lastDrainRequestPresent = false;
      throw error;
    }
  }

  function queueReconcile(source: DrainDetectionSource): void {
    reconcileTail = reconcileTail
      .catch(() => undefined)
      .then(() => reconcile(source))
      .catch((error) => {
        options.log?.(
          `[dispatcher] drain control reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  return {
    async start() {
      if (stopped) {
        throw new Error("drain control plane cannot be restarted after stop");
      }

      mkdirSync(controlDir, { recursive: true });
      ensureWatcher();
      await reconcile("startup");
      interval = setInterval(() => {
        ensureWatcher();
        queueReconcile("control-poll");
      }, options.controlPollMs);
    },

    stop() {
      stopped = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // Ignore close races.
        }
        watcher = null;
      }
    },

    snapshot,
  };
}
