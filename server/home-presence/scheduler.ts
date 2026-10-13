// 60 秒ごとに評価して event を送る。 Discord Bot の ON/OFF とは独立 (LINE だけでも動く)。

import type BetterSqlite3 from 'better-sqlite3';
import { evaluatePresence } from './evaluate.js';
import { dispatchEvent } from './engine.js';

type Db = BetterSqlite3.Database;

const INTERVAL_MS = 60_000;
let running = false;

async function tick(db: Db): Promise<void> {
  // 送信が 60 秒を超えても重ねて評価しない
  if (running) return;
  running = true;
  try {
    const { event } = evaluatePresence(db);
    if (event) {
      console.log(`[home-presence] event=${event}`);
      await dispatchEvent(db, event);
    }
  } finally {
    running = false;
  }
}

export function startHomePresenceScheduler(db: Db): void {
  const run = () => {
    void tick(db).catch((e: unknown) => {
      console.warn(`[home-presence] tick failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  setTimeout(run, 20_000).unref?.();
  setInterval(run, INTERVAL_MS).unref?.();
  console.log('[home-presence] scheduler started');
}
