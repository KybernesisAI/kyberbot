import { mkdir, readFile, rm, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { isProcessAlive } from "./git.js";

const DELAMAIN_REPO_MUTATION_LOCK_SCHEMA = "als-delamain-repo-mutation-lock@1";

export interface RepoMutationLeaseInput {
  dispatch_id: string;
  dispatcher_name: string;
  item_id: string;
  worktree_path: string;
}

interface RepoMutationLeaseRecord extends RepoMutationLeaseInput {
  schema: typeof DELAMAIN_REPO_MUTATION_LOCK_SCHEMA;
  acquired_at: string;
  owner_pid: number;
}

export interface RepoMutationLockSweepResult {
  released: boolean;
  stale: boolean;
  metadata: RepoMutationLeaseRecord | null;
}

interface RepoMutationLockOptions {
  pollMs?: number;
  staleMs?: number;
  timeoutMs?: number;
}

export class RepoMutationLock {
  private readonly pollMs: number;
  private readonly staleMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly systemRoot: string,
    options: RepoMutationLockOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 250;
    this.staleMs = options.staleMs ?? 5 * 60_000;
    // The lease wait must outlive stale detection so metadata-less crash windows
    // can self-heal without a guaranteed timeout on the first waiter.
    this.timeoutMs = Math.max(options.timeoutMs ?? 2 * 60_000, this.staleMs + this.pollMs);
  }

  async withLease<T>(
    input: RepoMutationLeaseInput,
    run: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(input);
    try {
      return await run();
    } finally {
      await release();
    }
  }

  async sweepStaleLease(now = new Date()): Promise<RepoMutationLockSweepResult> {
    const lockInfo = await stat(this.lockDirectoryPath()).catch((error) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!lockInfo) {
      return {
        released: false,
        stale: false,
        metadata: null,
      };
    }

    const metadata = await this.readMetadata();
    if (!metadata) {
      const metadataLessLockIsStale = now.getTime() - lockInfo.mtime.getTime() > this.staleMs;
      if (!metadataLessLockIsStale) {
        return {
          released: false,
          stale: false,
          metadata: null,
        };
      }

      await rm(this.lockDirectoryPath(), { recursive: true, force: true });
      return {
        released: true,
        stale: true,
        metadata: null,
      };
    }

    let isStale = !isProcessAlive(metadata.owner_pid);
    if (!isStale) {
      try {
        const info = await stat(this.metadataFilePath());
        isStale = now.getTime() - info.mtime.getTime() > this.staleMs;
      } catch {
        isStale = true;
      }
    }

    if (!isStale) {
      return {
        released: false,
        stale: false,
        metadata,
      };
    }

    await rm(this.lockDirectoryPath(), { recursive: true, force: true });
    return {
      released: true,
      stale: true,
      metadata,
    };
  }

  private async acquire(input: RepoMutationLeaseInput): Promise<() => Promise<void>> {
    const startedAt = Date.now();
    await mkdir(dirname(this.lockDirectoryPath()), { recursive: true });

    while (Date.now() - startedAt < this.timeoutMs) {
      try {
        await mkdir(this.lockDirectoryPath(), { recursive: false });
        const record: RepoMutationLeaseRecord = {
          schema: DELAMAIN_REPO_MUTATION_LOCK_SCHEMA,
          ...input,
          acquired_at: new Date().toISOString(),
          owner_pid: process.pid,
        };
        try {
          await writeFile(
            this.metadataFilePath(),
            JSON.stringify(record, null, 2) + "\n",
            "utf-8",
          );
        } catch (error) {
          await rm(this.lockDirectoryPath(), { recursive: true, force: true });
          throw error;
        }

        return async () => {
          await rm(this.lockDirectoryPath(), { recursive: true, force: true });
        };
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
          throw error;
        }

        await this.sweepStaleLease();
        await Bun.sleep(this.pollMs);
      }
    }

    throw new Error(
      `Timed out waiting for repo mutation lease at '${this.lockDirectoryPath()}'`,
    );
  }

  private async readMetadata(): Promise<RepoMutationLeaseRecord | null> {
    try {
      const raw = await readFile(this.metadataFilePath(), "utf-8");
      const parsed = JSON.parse(raw) as Partial<RepoMutationLeaseRecord>;
      if (parsed.schema !== DELAMAIN_REPO_MUTATION_LOCK_SCHEMA) return null;
      if (
        typeof parsed.dispatch_id !== "string"
        || typeof parsed.dispatcher_name !== "string"
        || typeof parsed.item_id !== "string"
        || typeof parsed.worktree_path !== "string"
        || typeof parsed.acquired_at !== "string"
        || typeof parsed.owner_pid !== "number"
      ) {
        return null;
      }
      return parsed as RepoMutationLeaseRecord;
    } catch {
      return null;
    }
  }

  private lockDirectoryPath(): string {
    return join(this.systemRoot, ".claude", "delamains", ".runtime", "repo-mutation.lock");
  }

  private metadataFilePath(): string {
    return join(this.lockDirectoryPath(), "lease.json");
  }
}
