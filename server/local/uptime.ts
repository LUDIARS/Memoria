// Server uptime tracking.
//
// On each tick (1s) we touch a heartbeat file with the current time. On the
// next process boot we read that file: if its mtime is in the past, we know
// the server was offline between (heartbeat) and (now). That gap is recorded
// as a downtime event.
//
// Why a file (not just memory)? — process can crash or be SIGKILL'd, in
// which case we never get a stop event. The heartbeat file gives us a
// "definitely-alive at" timestamp regardless of how the process ended.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { insertServerEvent } from '../db/index.js';

type Db = BetterSqlite3.Database;

const TICK_MS = 1000;
const RESTART_GRACE_MS = 5 * 60 * 1000; // 5 minutes — see DOWNTIME_THRESHOLD_MS

let timer: NodeJS.Timeout | null = null;
let installedShutdownHandlers = false;
let activeDb: Db | null = null;
let activeFile: string | null = null;
let bootTime: Date | null = null;
let startEventId: number | null = null;

export const DOWNTIME_THRESHOLD_MS = 5 * 60 * 1000;

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

export function startUptimeTracking({ db, dataDir, heartbeatFile }: StartUptimeArgs): void {
  if (timer) stopUptimeTracking();
  activeDb = db;
  activeFile = heartbeatFile || `${dataDir}/heartbeat.json`;
  mkdirSync(dirname(activeFile), { recursive: true });

  bootTime = new Date();
  let priorHeartbeat: Date | null = null;
  if (existsSync(activeFile)) {
    try {
      const raw = readFileSync(activeFile, 'utf8');
      const parsed = JSON.parse(raw) as { last_heartbeat_at?: string };
      if (parsed?.last_heartbeat_at) priorHeartbeat = new Date(parsed.last_heartbeat_at);
    } catch { /* swallow */ }
  }

  // Record the start event.
  startEventId = insertServerEvent(db, {
    type: 'start',
    occurredAt: bootTime.toISOString(),
    details: { pid: process.pid },
  });
  void startEventId;

  // Compute the gap since last heartbeat — if any.
  if (priorHeartbeat && Number.isFinite(priorHeartbeat.getTime())) {
    const gapMs = bootTime.getTime() - priorHeartbeat.getTime();
    if (gapMs > 0) {
      const downtimeOrRestart = gapMs <= RESTART_GRACE_MS ? 'restart' : 'downtime';
      insertServerEvent(db, {
        type: downtimeOrRestart,
        occurredAt: priorHeartbeat.toISOString(),
        endedAt: bootTime.toISOString(),
        durationMs: gapMs,
        details: { reason: 'inferred from heartbeat gap' },
      });
      console.log(`[uptime] previous run ended ${priorHeartbeat.toISOString()} — `
        + `${downtimeOrRestart} ${Math.round(gapMs / 1000)}s`);
    }
  }

  // Heartbeat tick.
  const tick = (): void => {
    if (!activeFile || !bootTime) return;
    try {
      writeFileSync(activeFile, JSON.stringify({
        server_started_at: bootTime.toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        pid: process.pid,
      }), 'utf8');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[uptime] heartbeat write failed: ${msg}`);
    }
  };
  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();

  if (!installedShutdownHandlers) {
    installedShutdownHandlers = true;
    const shutdown = (signal: string): void => {
      try { recordCleanShutdown(signal); } catch { /* swallow */ }
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGHUP', () => shutdown('SIGHUP'));
    process.on('beforeExit', () => { try { recordCleanShutdown('beforeExit'); } catch { /* swallow */ } });
  }
}

export function stopUptimeTracking(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function recordCleanShutdown(signal: string): void {
  if (!activeDb || !bootTime) return;
  const now = new Date();
  insertServerEvent(activeDb, {
    type: 'stop',
    occurredAt: now.toISOString(),
    details: { signal, started_at: bootTime.toISOString() },
  });
  // Also bump the heartbeat to "now" so a fresh boot doesn't see a tiny gap
  // and call it a downtime.
  if (activeFile) {
    try {
      writeFileSync(activeFile, JSON.stringify({
        server_started_at: bootTime.toISOString(),
        last_heartbeat_at: now.toISOString(),
        clean_shutdown: true,
        signal,
      }), 'utf8');
    } catch { /* swallow */ }
  }
  stopUptimeTracking();
}

export function readHeartbeat(heartbeatFile: string): HeartbeatRecord | null {
  if (!existsSync(heartbeatFile)) return null;
  try {
    return JSON.parse(readFileSync(heartbeatFile, 'utf8')) as HeartbeatRecord;
  } catch {
    return null;
  }
}
