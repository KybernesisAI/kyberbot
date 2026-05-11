import {
  emptyRuntimeState,
  readRuntimeState,
  summarizeRuntimeState,
  type RuntimeDispatchRecord,
  type RuntimeDispatchState,
  type RuntimeDispatchSummary,
  writeRuntimeState,
} from "./runtime-state.js";

export interface RegistryStatusRelease {
  itemId: string;
  previousStatus: string;
  nextStatus: string;
  previousRecordStatus: RuntimeDispatchRecord["status"];
}

export class DispatchRegistry {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly bundleRoot: string) {}

  async list(): Promise<RuntimeDispatchRecord[]> {
    return (await readRuntimeState(this.bundleRoot)).records;
  }

  async summary(): Promise<RuntimeDispatchSummary> {
    return summarizeRuntimeState(await readRuntimeState(this.bundleRoot));
  }

  async getByItemId(itemId: string): Promise<RuntimeDispatchRecord | null> {
    const records = await this.list();
    return records.find((record) => record.item_id === itemId) ?? null;
  }

  async create(record: RuntimeDispatchRecord): Promise<boolean> {
    return this.mutate((state) => {
      if (state.records.some((existing) => existing.item_id === record.item_id)) {
        return false;
      }

      state.records.push(record);
      return true;
    });
  }

  async touchDispatch(dispatchId: string, timestamp = new Date().toISOString()): Promise<void> {
    await this.mutate((state) => {
      const record = state.records.find((entry) => entry.dispatch_id === dispatchId);
      if (!record) return null;

      record.heartbeat_at = timestamp;
      record.updated_at = timestamp;
      return null;
    });
  }

  async updateByItemId(
    itemId: string,
    update: (record: RuntimeDispatchRecord) => RuntimeDispatchRecord,
  ): Promise<RuntimeDispatchRecord | null> {
    return this.mutate((state) => {
      const index = state.records.findIndex((record) => record.item_id === itemId);
      if (index === -1) return null;

      const nextRecord = update(structuredClone(state.records[index]!));
      state.records[index] = nextRecord;
      return nextRecord;
    });
  }

  async removeByItemId(itemId: string): Promise<RuntimeDispatchRecord | null> {
    return this.mutate((state) => {
      const index = state.records.findIndex((record) => record.item_id === itemId);
      if (index === -1) return null;

      const [removed] = state.records.splice(index, 1);
      return removed ?? null;
    });
  }

  async reconcileObservedItems(
    items: ReadonlyArray<{ id: string; status: string }>,
  ): Promise<RegistryStatusRelease[]> {
    const observed = new Map(items.map((item) => [item.id, item.status]));

    return this.mutate((state) => {
      const releases: RegistryStatusRelease[] = [];
      state.records = state.records.filter((record) => {
        const currentStatus = observed.get(record.item_id);
        if (!currentStatus || currentStatus === record.state) {
          return true;
        }

        releases.push({
          itemId: record.item_id,
          previousStatus: record.state,
          nextStatus: currentStatus,
          previousRecordStatus: record.status,
        });
        return false;
      });

      return releases;
    });
  }

  private async mutate<T>(
    mutator: (state: RuntimeDispatchState) => T | Promise<T>,
  ): Promise<T> {
    let result!: T;

    const work = this.queue
      .catch(() => undefined)
      .then(async () => {
        const state = await readRuntimeState(this.bundleRoot).catch((error) => {
          if (error instanceof Error && error.message.includes("unsupported schema")) {
            throw error;
          }
          return emptyRuntimeState();
        });
        result = await mutator(state);
        state.updated_at = new Date().toISOString();
        await writeRuntimeState(this.bundleRoot, state);
      });

    this.queue = work.then(() => undefined, () => undefined);
    await work;
    return result;
  }
}
