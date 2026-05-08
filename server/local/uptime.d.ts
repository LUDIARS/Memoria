// Type shims for local/uptime.js.

import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export const DOWNTIME_THRESHOLD_MS: number;

export interface StartUptimeArgs {
  db: Db;
  dataDir: string;
  heartbeatFile?: string;
}

export interface HeartbeatRecord {
  last_heartbeat_at?: string;
  pid?: number;
  [key: string]: unknown;
}

export function startUptimeTracking(args: StartUptimeArgs): void;
export function stopUptimeTracking(): void;
export function readHeartbeat(heartbeatFile: string): HeartbeatRecord | null;
