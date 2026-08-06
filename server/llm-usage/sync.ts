import type BetterSqlite3 from 'better-sqlite3';
import { captureInventory } from './inventory.js';
import { listRecentNativeLogs, parseNativeLog } from './native-log-reader.js';
import { importDays, isSourceCurrent, recordSourceFailure, replaceSourceUsage, saveInventorySnapshot } from './store.js';
import type { SyncResult } from './types.js';

type Db = BetterSqlite3.Database;
const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;

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
    const cutoffMs = importWindowStartMs(importDays());
    const replaceFromDate = usageDate(cutoffMs);
    const sources = await listRecentNativeLogs(cutoffMs);
    this.statusValue.progress.total = sources.length;
    const result: SyncResult = {
      scannedSources: sources.length,
      importedSources: 0,
      unchangedSources: 0,
      failedSources: 0,
      importedRecords: 0,
      inventoryCaptured: false,
    };
    for (const source of sources) {
      try {
        if (isSourceCurrent(this.db, source)) {
          result.unchangedSources += 1;
        } else {
          const parsed = await parseNativeLog(source, cutoffMs);
          result.importedRecords += replaceSourceUsage(this.db, source, parsed, replaceFromDate);
          result.importedSources += 1;
        }
      } catch (error: unknown) {
        result.failedSources += 1;
        recordSourceFailure(this.db, source, error instanceof Error ? error.message : String(error));
      } finally {
        this.statusValue.progress.current += 1;
      }
    }
    const inventory = await captureInventory(this.db);
    saveInventorySnapshot(this.db, inventory);
    result.inventoryCaptured = true;
    return result;
  }
}

export function importWindowStartMs(days: number, nowMs = Date.now()): number {
  const localDay = new Date(nowMs + JST_OFFSET_MS);
  localDay.setUTCHours(0, 0, 0, 0);
  localDay.setUTCDate(localDay.getUTCDate() - (days - 1));
  return localDay.getTime() - JST_OFFSET_MS;
}

function usageDate(timeMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(timeMs));
}
