// Post the RSS daily digest to Discord #news.

import type { Client } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';
import { discordSettings } from './settings.js';
import { postToChannel } from './notifier.js';
import { getOrCreateDigest } from '../rss/index.js';

type Db = BetterSqlite3.Database;

const MAX_LEN = 1900;

function chunk(text: string): string[] {
  if (text.length <= MAX_LEN) return [text];
  const out: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > MAX_LEN) {
      if (buf) out.push(buf);
      buf = '';
    }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) out.push(buf);
  return out;
}

export interface NewsPostResult {
  ok: boolean;
  reason?: string;
  digestPosted: boolean;
  trendingPosted: boolean;
}

/** Post only the daily RSS digest. Keep trendingPosted for API compatibility. */
export async function postRssNews(client: Client, db: Db): Promise<NewsPostResult> {
  if (!discordSettings(db).news) {
    return { ok: false, reason: 'news disabled', digestPosted: false, trendingPosted: false };
  }

  let digestPosted = false;
  try {
    const digest = await getOrCreateDigest(db);
    if (digest?.content) {
      await postToChannel(client, db, 'news', `📰 **今日のダイジェスト**（${digest.date}）`);
      for (const part of chunk(digest.content)) {
        await postToChannel(client, db, 'news', part);
      }
      digestPosted = true;
    }
  } catch (e: unknown) {
    console.warn('[discord news] digest failed:', e instanceof Error ? e.message : String(e));
  }

  return { ok: digestPosted, digestPosted, trendingPosted: false };
}

/** "HH:MM" または整数時刻を [hour, minute] に変換。既定 [8, 0]。 */
function parseNewsTime(s: Record<string, string | null>): [number, number] {
  const t = String(s['features.discord.news_time'] ?? '').trim();
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = Number(m[1]); const min = Number(m[2]);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return [h, min];
  }
  // 旧キー (整数時刻) にフォールバック
  const hour = Number(s['features.discord.news_hour']);
  return [Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : 8, 0];
}

// Check once a minute and post at features.discord.news_time (default "08:00"),
// once per local day. Falls back to features.discord.news_hour for compatibility.
export function startNewsScheduler(client: Client, db: Db): void {
  setInterval(() => {
    try {
      const cfg = discordSettings(db);
      if (!cfg.news) return;
      const s = getAppSettings(db);
      const [targetHour, targetMin] = parseNewsTime(s);
      const now = new Date();
      if (now.getHours() !== targetHour || now.getMinutes() !== targetMin) return;
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      if (s['features.discord.news_last_sent'] === today) return;
      setAppSettings(db, { 'features.discord.news_last_sent': today });
      void postRssNews(client, db).then((r) => {
        console.log(`[discord news] posted: digest=${r.digestPosted}`);
      });
    } catch (e: unknown) {
      console.warn('[discord news] tick failed:', e instanceof Error ? e.message : String(e));
    }
  }, 60_000).unref?.();
  console.log('[discord news] digest scheduler started');
}
