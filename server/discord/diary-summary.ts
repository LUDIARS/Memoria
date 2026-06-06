// Post yesterday's diary summary to Discord #announce every morning.

import type { Client } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, getDiary, setAppSettings } from '../db.js';
import { postAnnouncement } from './notifier.js';
import { discordSettings } from './settings.js';

type Db = BetterSqlite3.Database;

const MAX_BODY_LEN = 1800;
const TITLE_YESTERDAY_DIARY_SUMMARY = '\u6628\u65e5\u306e\u65e5\u8a18\u30b5\u30de\u30ea\u30fc';
let posting = false;

function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function yesterday(now = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return localDate(d);
}

function truncate(text: string, maxLen = MAX_BODY_LEN): string {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 3).trimEnd()}...`;
}

function diarySummaryText(entry: ReturnType<typeof getDiary>): string | null {
  if (!entry || entry.status !== 'done') return null;
  const text = entry.highlights?.trim()
    || entry.summary?.trim()
    || entry.work_content?.trim()
    || '';
  return text ? truncate(text) : null;
}

async function tryPostYesterdayDiarySummary(client: Client, db: Db, now = new Date()): Promise<boolean> {
  const date = yesterday(now);
  const entry = getDiary(db, date);
  const body = diarySummaryText(entry);
  if (!body) return false;

  await postAnnouncement(client, db, `**${TITLE_YESTERDAY_DIARY_SUMMARY}** (${date})\n${body}`);
  setAppSettings(db, { 'features.discord.diary_summary_last_sent': localDate(now) });
  console.log(`[discord diary] posted summary for ${date}`);
  return true;
}

// Default 07:30 local. If the diary is still running, retry until noon.
export function startDiarySummaryScheduler(client: Client, db: Db): void {
  setInterval(() => {
    try {
      const cfg = discordSettings(db);
      if (!cfg.enabled || !cfg.announce) return;

      const s = getAppSettings(db);
      const hour = Number(s['features.discord.diary_summary_hour']);
      const minute = Number(s['features.discord.diary_summary_minute']);
      const targetHour = Number.isFinite(hour) ? hour : 7;
      const targetMinute = Number.isFinite(minute) ? minute : 30;

      const now = new Date();
      const today = localDate(now);
      if (s['features.discord.diary_summary_last_sent'] === today) return;
      if (now.getHours() < targetHour) return;
      if (now.getHours() === targetHour && now.getMinutes() < targetMinute) return;
      if (now.getHours() >= 12) return;

      if (posting) return;
      posting = true;
      void tryPostYesterdayDiarySummary(client, db, now)
        .catch((e: unknown) => {
          console.warn('[discord diary] post failed:', e instanceof Error ? e.message : String(e));
        })
        .finally(() => { posting = false; });
    } catch (e: unknown) {
      console.warn('[discord diary] tick failed:', e instanceof Error ? e.message : String(e));
    }
  }, 60_000).unref?.();
  console.log('[discord diary] summary scheduler started');
}
