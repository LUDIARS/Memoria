// ai-hub — 朝 6 時の記事ダイジェスト + AIアドバイスの tick。
// 既存 goals/eval-scheduler.ts と同形: 毎分 setInterval で時刻を見て、 設定時刻と
// 一致 + 当日未実行 (app_settings の *.last_date ガード) のときだけ走る。
// try/catch で全体を止めない。 .unref?.() で process 終了を妨げない。
// Spec: spec/feature/ai-hub.md §スケジューラ起動

import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';
import { formatLocalDate, yesterdayLocal } from '../diary.js';
import { runDigest } from './digest.js';
import { runAdvice } from './advice.js';

type Db = BetterSqlite3.Database;

const DEFAULT_TIME = '06:00';

/** 'HH:MM' を {hour, minute} に。 不正なら既定 06:00。 */
function parseTime(raw: string | null | undefined): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec((raw || DEFAULT_TIME).trim());
  if (!m) return { hour: 6, minute: 0 };
  const hour = Math.min(23, Math.max(0, Number(m[1])));
  const minute = Math.min(59, Math.max(0, Number(m[2])));
  return { hour, minute };
}

/** '1' / 未設定 を enabled、 それ以外を disabled とみなす (既定 ON)。 */
function isEnabled(value: string | null | undefined): boolean {
  return value == null ? true : value === '1';
}

export function startAiHubSchedulers(db: Db): void {
  const tick = () => {
    const now = new Date();
    const today = formatLocalDate(now);

    // ── 記事ダイジェスト (対象日 = 昨日) ──────────────────────────────────
    try {
      const appS = getAppSettings(db);
      if (isEnabled(appS['ai_digest.enabled'])) {
        const { hour, minute } = parseTime(appS['ai_digest.time']);
        if (now.getHours() === hour && now.getMinutes() === minute
            && appS['ai_digest.last_date'] !== today) {
          // 先にガードを立て (二重実行防止)、 非同期処理を投げる。
          setAppSettings(db, { 'ai_digest.last_date': today });
          const target = yesterdayLocal(now);
          void runDigest(db, target).catch((e: unknown) => {
            console.warn('[ai-hub digest] run failed:', e instanceof Error ? e.message : String(e));
          });
        }
      }
    } catch (e: unknown) {
      console.warn('[ai-hub digest] tick failed:', e instanceof Error ? e.message : String(e));
    }

    // ── AIアドバイス (対象日 = 当日、 直近 7 日を集計) ────────────────────
    try {
      const appS = getAppSettings(db);
      if (isEnabled(appS['ai_advice.enabled'])) {
        const { hour, minute } = parseTime(appS['ai_advice.time']);
        if (now.getHours() === hour && now.getMinutes() === minute
            && appS['ai_advice.last_date'] !== today) {
          setAppSettings(db, { 'ai_advice.last_date': today });
          void runAdvice(db, today).catch((e: unknown) => {
            console.warn('[ai-hub advice] run failed:', e instanceof Error ? e.message : String(e));
          });
        }
      }
    } catch (e: unknown) {
      console.warn('[ai-hub advice] tick failed:', e instanceof Error ? e.message : String(e));
    }
  };

  setInterval(() => { tick(); }, 60_000).unref?.();
}
