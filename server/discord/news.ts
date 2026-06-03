// RSS「今日のダイジェスト」+「気になるニュース (トレンド検知)」を Discord の
// #news チャンネルに投稿する。 Memoria Discord Bot はアダプタ層なので、 ここから
// rss ドメイン (getOrCreateDigest / listTrendingArticles) を呼んで整形・送信する。

import type { Client } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';
import { discordSettings } from './settings.js';
import { postToChannel } from './notifier.js';
import { getOrCreateDigest, listTrendingArticles } from '../rss/index.js';

type Db = BetterSqlite3.Database;

const MAX_LEN = 1900; // Discord 2000 文字制限の手前で分割

function chunk(text: string): string[] {
  if (text.length <= MAX_LEN) return [text];
  const out: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > MAX_LEN) { if (buf) out.push(buf); buf = ''; }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) out.push(buf);
  return out;
}

function trendingBlock(db: Db): string | null {
  const items = listTrendingArticles(db, 24, 8);
  if (!items.length) return null;
  const lines = items.map((a) => {
    let traffic = '';
    if (a.meta_json) {
      try {
        const m = JSON.parse(a.meta_json) as { approx_traffic?: string };
        if (m.approx_traffic) traffic = ` — 🔥${m.approx_traffic} 検索`;
      } catch { /* ignore */ }
    }
    const tag = a.feed_kind === 'google_trends' ? '📈' : '🔖';
    const link = a.url ? `[${a.title}](${a.url})` : a.title;
    return `${tag} ${link}${traffic}`;
  });
  return `📈 **気になるニュース（トレンド検知）**\n${lines.join('\n')}`;
}

export interface NewsPostResult {
  ok: boolean;
  reason?: string;
  digestPosted: boolean;
  trendingPosted: boolean;
}

/** ダイジェスト + トレンドを #news に投稿する。 best-effort。 */
export async function postRssNews(client: Client, db: Db): Promise<NewsPostResult> {
  if (!discordSettings(db).news) return { ok: false, reason: 'news disabled', digestPosted: false, trendingPosted: false };

  let digestPosted = false;
  let trendingPosted = false;

  // 今日のダイジェスト (無ければ生成)。
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

  // 気になるニュース (トレンド検知)。
  try {
    const block = trendingBlock(db);
    if (block) {
      for (const part of chunk(block)) await postToChannel(client, db, 'news', part);
      trendingPosted = true;
    }
  } catch (e: unknown) {
    console.warn('[discord news] trending failed:', e instanceof Error ? e.message : String(e));
  }

  return { ok: digestPosted || trendingPosted, digestPosted, trendingPosted };
}

// 1 分ごとに時刻チェックし、 設定時刻 (既定 8 時) に 1 日 1 回だけ自動投稿。
export function startNewsScheduler(client: Client, db: Db): void {
  setInterval(() => {
    try {
      const cfg = discordSettings(db);
      if (!cfg.news) return;
      const s = getAppSettings(db);
      const hour = Number(s['features.discord.news_hour']);
      const targetHour = Number.isFinite(hour) ? hour : 8;
      const now = new Date();
      if (now.getHours() !== targetHour || now.getMinutes() !== 0) return;
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      if (s['features.discord.news_last_sent'] === today) return;
      setAppSettings(db, { 'features.discord.news_last_sent': today });
      void postRssNews(client, db).then((r) => {
        console.log(`[discord news] posted: digest=${r.digestPosted} trending=${r.trendingPosted}`);
      });
    } catch (e: unknown) {
      console.warn('[discord news] tick failed:', e instanceof Error ? e.message : String(e));
    }
  }, 60_000).unref?.();
  console.log('[discord news] news scheduler started');
}
