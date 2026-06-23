// 朝のおすすめ自動生成 + #recommend 投稿スケジューラ。
// news.ts と同じパターン: 毎分 tick して設定時刻に 1 日 1 回発火。

import type { Client } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';
import { discordSettings } from './settings.js';
import { postToChannel } from './notifier.js';
import { runAiRecommendations, isAiRecommendationsAvailable, REC_AXIS_LABELS, type RecResultItem } from '../recommendations-ai.js';

type Db = BetterSqlite3.Database;

function localDateStr(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * おすすめ結果を 1 アイテム 1 メッセージ の配列で返す。
 * 先頭はヘッダー、以降は各アイテム (軸ラベル + タイトル + URL + 補足)。
 * リアクション FB・URL コピーのため分割する。
 *
 * 2 軸 (停滞打開 / 不足補間) の両方が出るよう、 各軸から最大 3 件ずつ拾って交互に並べる。
 */
function formatRecommendMessages(items: RecResultItem[]): string[] {
  const stagnation = items.filter((it) => it.axis === 'stagnation').slice(0, 3);
  const antenna = items.filter((it) => it.axis === 'news_antenna').slice(0, 3);
  // 交互に並べて両軸を均等に見せる (片方が尽きたら残りをそのまま続ける)。
  const shown: RecResultItem[] = [];
  for (let i = 0; i < Math.max(stagnation.length, antenna.length); i++) {
    if (stagnation[i]) shown.push(stagnation[i]);
    if (antenna[i]) shown.push(antenna[i]);
  }

  const messages: string[] = [];
  for (let i = 0; i < shown.length; i++) {
    const it = shown[i];
    const axisLabel = REC_AXIS_LABELS[it.axis] ?? '';
    const tag = axisLabel ? `\`${axisLabel}\` ` : '';
    const title = (it.title || it.url).slice(0, 80);
    const url = it.url.slice(0, 120);
    const why = (it.why || '').slice(0, 150);
    const val = (it.expected_value || '').slice(0, 80);
    const supplement = [why, val].filter(Boolean).join(' — ');
    messages.push(supplement
      ? `**${i + 1}.** ${tag}${title}\n${url}\n> ${supplement}`
      : `**${i + 1}.** ${tag}${title}\n${url}`);
  }

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
 * "HH:MM" 文字列を [hour, minute] に分解。不正なら既定値 [8, 0] を返す。
 * 設定キー: features.discord.recommend_time (例: "06:30")
 */
function parseTimeStr(raw: unknown): [number, number] {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return [8, 0];
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return [8, 0];
  return [h, min];
}

/**
 * 毎分 tick して `features.discord.recommend_time`(既定 "08:00") に 1 日 1 回
 * おすすめを生成して #recommend へ投稿するスケジューラ。
 * `cfg.autoRecommend` が OFF なら何もしない。
 */
export function startRecommendScheduler(client: Client, db: Db): void {
  setInterval(() => {
    try {
      const cfg = discordSettings(db);
      if (!cfg.autoRecommend) return;
      const s = getAppSettings(db);
      const [targetHour, targetMin] = parseTimeStr(s['features.discord.recommend_time']);
      const now = new Date();
      if (now.getHours() !== targetHour || now.getMinutes() !== targetMin) return;
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
