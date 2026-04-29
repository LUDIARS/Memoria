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
import { insertServerEvent } from './db.js';

const TICK_MS = 1000;
const RESTART_GRACE_MS = 5 * 60 * 1000; // 5 minutes — see DOWNTIME_THRESHOLD_MS

let timer = null;
let installedShutdownHandlers = false;
let activeDb = null;
let activeFile = null;
let bootTime = null;
let startEventId = null;

export const DOWNTIME_THRESHOLD_MS = 5 * 60 * 1000;

export function startUptimeTracking({ db, dataDir, heartbeatFile }) {
  if (timer) stopUptimeTracking();
  activeDb = db;
  activeFile = heartbeatFile || `${dataDir}/heartbeat.json`;
  mkdirSync(dirname(activeFile), { recursive: true });

  bootTime = new Date();
  let priorHeartbeat = null;
  if (existsSync(activeFile)) {
    try {
      const raw = readFileSync(activeFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.last_heartbeat_at) priorHeartbeat = new Date(parsed.last_heartbeat_at);
    } catch {}
  }

  // Record the start event.
  startEventId = insertServerEvent(db, {
    type: 'start',
    occurredAt: bootTime.toISOString(),
    details: { pid: process.pid },
  });

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
  const tick = () => {
    try {
      writeFileSync(activeFile, JSON.stringify({
        server_started_at: bootTime.toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        pid: process.pid,
      }), 'utf8');
    } catch (e) {
      console.warn(`[uptime] heartbeat write failed: ${e.message}`);
    }
  };
  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();

  if (!installedShutdownHandlers) {
    installedShutdownHandlers = true;
    const shutdown = (signal) => {
      try { recordCleanShutdown(signal); } catch {}
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGHUP', () => shutdown('SIGHUP'));
    process.on('beforeExit', () => { try { recordCleanShutdown('beforeExit'); } catch {} });
  }
}

export function stopUptimeTracking() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function recordCleanShutdown(signal) {
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
    } catch {}
  }
  stopUptimeTracking();
}

export function readHeartbeat(heartbeatFile) {
  if (!existsSync(heartbeatFile)) return null;
  try {
    return JSON.parse(readFileSync(heartbeatFile, 'utf8'));
  } catch {
    return null;
  }
}
