// 朝のおすすめ自動生成 + #recommend 投稿スケジューラ。
// news.ts と同じパターン: 毎分 tick して設定時刻に 1 日 1 回発火。

import type { Client } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';
import { discordSettings } from './settings.js';
import { postToChannel } from './notifier.js';
import { runAiRecommendations, isAiRecommendationsAvailable, type RecResultItem } from '../recommendations-ai.js';

type Db = BetterSqlite3.Database;

const MAX_LEN = 1900;

function localDateStr(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * おすすめ結果をタイトル + 補足 (why / expected_value) 付きで Discord 用にフォーマット。
 * 1900 字制限に合わせて複数メッセージに分割して返す。
 */
function formatRecommendMessages(items: RecResultItem[]): string[] {
  const shown = items.slice(0, 5);
  const header = `🎯 **今日のおすすめ** (${shown.length}件)`;
  const blocks: string[] = [header];

  for (let i = 0; i < shown.length; i++) {
    const it = shown[i];
    const title = (it.title || it.url).slice(0, 80);
    const url = it.url.slice(0, 120);
    const why = (it.why || '').slice(0, 120);
    const val = (it.expected_value || '').slice(0, 60);
    const supplement = [why, val].filter(Boolean).join(' — ');
    const block = supplement
      ? `**${i + 1}.** ${title}\n${url}\n> ${supplement}`
      : `**${i + 1}.** ${title}\n${url}`;
    blocks.push(block);
  }

  // 1900 字単位に分割
  const messages: string[] = [];
  let buf = '';
  for (const b of blocks) {
    const sep = buf ? '\n\n' : '';
    if (buf.length + sep.length + b.length > MAX_LEN) {
      if (buf) messages.push(buf.trim());
      buf = b;
    } else {
      buf += sep + b;
    }
  }
  if (buf) messages.push(buf.trim());
  return messages;
}

/** おすすめを生成して #recommend に投稿する seam。Bot 未起動なら呼ばない想定。 */
export async function postMorningRecommend(client: Client, db: Db): Promise<{ ok: boolean; count: number }> {
  const avail = isAiRecommendationsAvailable();
  if (!avail.available) {
    console.warn(`[discord recommend] skip: ${avail.reason}`);
    return { ok: false, count: 0 };
  }
  try {
    const result = await runAiRecommendations(db, { force: true });
    const items = result.items ?? [];
    if (!items.length) {
      await postToChannel(client, db, 'recommend', '🎯 今日のおすすめ — 該当なし');
      return { ok: true, count: 0 };
    }
    for (const msg of formatRecommendMessages(items)) {
      await postToChannel(client, db, 'recommend', msg);
    }
    return { ok: true, count: items.length };
  } catch (e: unknown) {
    console.warn('[discord recommend] generation failed:', e instanceof Error ? e.message : String(e));
    return { ok: false, count: 0 };
  }
}

/**
 * 毎分 tick して `features.discord.recommend_hour`(既定 8) 時 00 分に 1 日 1 回
 * おすすめを生成して #recommend へ投稿するスケジューラ。
 * `cfg.autoRecommend` が OFF なら何もしない。
 */
export function startRecommendScheduler(client: Client, db: Db): void {
  setInterval(() => {
    try {
      const cfg = discordSettings(db);
      if (!cfg.autoRecommend) return;
      const s = getAppSettings(db);
      const raw = Number(s['features.discord.recommend_hour']);
      const targetHour = Number.isFinite(raw) && raw >= 0 && raw <= 23 ? raw : 8;
      const now = new Date();
      if (now.getHours() !== targetHour || now.getMinutes() !== 0) return;
      const today = localDateStr(now);
      if (s['features.discord.recommend_last_sent'] === today) return;
      setAppSettings(db, { 'features.discord.recommend_last_sent': today });
      void postMorningRecommend(client, db).then((r) => {
        console.log(`[discord recommend] morning post: ok=${r.ok} count=${r.count}`);
      });
    } catch (e: unknown) {
      console.warn('[discord recommend] tick failed:', e instanceof Error ? e.message : String(e));
    }
  }, 60_000).unref?.();
  console.log('[discord recommend] morning scheduler started');
}
