// 定期ブリーフィングのスケジューラ。 稼働時間帯に intervalMinutes おきに 1 回、
// ブリーフィングを組み立てて Discord (#briefing) と Hora に投稿する。
// 既存の RSS poll と同じ「1 分 tick + lastRun ガード」 方式。

import type BetterSqlite3 from 'better-sqlite3';
import { getBriefingConfig } from './config.js';
import { buildBriefing } from './compose.js';
import { formatForDiscord, formatForHora } from './format.js';
import { postBriefingToHora } from './hora.js';
import { postBriefingToDiscord, discordClientReady } from '../discord/index.js';

type Db = BetterSqlite3.Database;

export function startBriefingScheduler(db: Db): void {
  let lastRun = 0;

  const tick = async () => {
    try {
      const cfg = getBriefingConfig(db);
      if (!cfg.enabled) return;

      const now = new Date();
      const hour = now.getHours();
      if (hour < cfg.activeStartHour || hour >= cfg.activeEndHour) return;

      // 送信先が無いなら組み立てもしない (外部 API を無駄叩きしない)。
      const wantDiscord = cfg.toDiscord && discordClientReady();
      const wantHora = cfg.hora.enabled && !!cfg.hora.url;
      if (!wantDiscord && !wantHora) return;

      const intervalMs = cfg.intervalMinutes * 60 * 1000;
      if (Date.now() - lastRun < intervalMs) return;
      lastRun = Date.now();

      const briefing = await buildBriefing(db, cfg);
      if (!briefing.blocks.length) return;

      if (wantDiscord) {
        await postBriefingToDiscord(db, formatForDiscord(briefing));
      }
      if (wantHora) {
        await postBriefingToHora(cfg.hora.url, formatForHora(briefing));
      }
      console.log(`[briefing] posted ${briefing.blocks.length} sections (discord=${wantDiscord} hora=${wantHora})`);
    } catch (e: unknown) {
      console.warn('[briefing] tick failed:', e instanceof Error ? e.message : String(e));
    }
  };

  // 起動 50s 後に初回判定 (lastRun=0 なので送信先があれば即投稿)、 以後 1 分ごと。
  setTimeout(() => { void tick(); }, 50_000).unref?.();
  setInterval(() => { void tick(); }, 60_000).unref?.();
}
