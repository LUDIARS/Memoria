import type BetterSqlite3 from 'better-sqlite3';
import { captureInventory } from './inventory.js';
import { saveInventorySnapshot } from './inventory-store.js';
import { listRecentNativeLogs, parseNativeLog, type NativeLogRoot } from './native-log-reader.js';
import { importSourceResponses, repriceStaleResponses } from './response-store.js';
import { isSourceCurrent, recordSourceFailure } from './source-store.js';
import { importDays, importWindowStartMs } from './sync-window.js';
import type { SyncResult } from './types.js';

type Db = BetterSqlite3.Database;

export interface UsageSyncStatus {
  state: 'idle' | 'running' | 'complete' | 'failed';
  startedAt: string | null;
  completedAt: string | null;
  progress: { current: number; total: number };
  result: SyncResult | null;
  error: string | null;
}
export class UsageSyncCoordinator {
  private statusValue: UsageSyncStatus = {
    state: 'idle', startedAt: null, completedAt: null,
    progress: { current: 0, total: 0 }, result: null, error: null,
  };

  constructor(private readonly db: Db) {}

  status(): UsageSyncStatus {
    return structuredClone(this.statusValue);
  }

  start(): UsageSyncStatus {
    if (this.statusValue.state === 'running') return this.status();
    this.statusValue = {
      state: 'running', startedAt: new Date().toISOString(), completedAt: null,
      progress: { current: 0, total: 0 }, result: null, error: null,
    };
    this.run().then(
      (result) => {
        this.statusValue = {
          ...this.statusValue,
          state: 'complete', completedAt: new Date().toISOString(), result,
        };
      },
      (error: unknown) => {
        this.statusValue = {
          ...this.statusValue,
          state: 'failed', completedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
      },
    );
    return this.status();
  }

  private async run(): Promise<SyncResult> {
    const result = await syncNativeUsage(this.db, importWindowStartMs(importDays()), undefined, (current, total) => {
      this.statusValue.progress = { current, total };
    });
    const inventory = await captureInventory(this.db);
    saveInventorySnapshot(this.db, inventory);
    result.inventoryCaptured = true;
    return result;
  }
}

/**
 * Import every changed native log in the window, then re-price stored responses
 * whose rate-table version is stale (their logs may be unchanged or already gone).
 */
export async function syncNativeUsage(
  db: Db,
  cutoffMs: number,
  roots?: NativeLogRoot[],
  onProgress: (current: number, total: number) => void = () => undefined,
): Promise<SyncResult> {
  const sources = await listRecentNativeLogs(cutoffMs, roots);
  const result: SyncResult = {
    scannedSources: sources.length,
    importedSources: 0,
    unchangedSources: 0,
    failedSources: 0,
    importedResponses: 0,
    repricedResponses: 0,
    inventoryCaptured: false,
  };
  onProgress(0, sources.length);
  for (const [index, source] of sources.entries()) {
    try {
      if (isSourceCurrent(db, source)) {
        result.unchangedSources += 1;
      } else {
        const parsed = await parseNativeLog(source, cutoffMs);
        result.importedResponses += importSourceResponses(db, source, parsed);
        result.importedSources += 1;
      }
    } catch (error: unknown) {
      result.failedSources += 1;
      recordSourceFailure(db, source, error instanceof Error ? error.message : String(error));
    } finally {
      onProgress(index + 1, sources.length);
    }
  }
  result.repricedResponses = repriceStaleResponses(db);
  return result;
}
