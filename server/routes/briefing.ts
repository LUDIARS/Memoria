// /api/briefing/* — 定期ブリーフィングのプレビューと即時テスト送信。
//
// scheduler が稼働時間帯に自動投稿するが、 出力確認 (Discord 設定不要) と
// 手動テスト送信のために 2 つの薄い endpoint を出す。

import { Hono } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { getBriefingConfig, buildBriefing, formatForDiscord, formatForHora, postBriefingToHora } from '../briefing/index.js';
import { postBriefingToDiscord, discordClientReady } from '../discord/index.js';

type Db = BetterSqlite3.Database;

export function makeBriefingRouter(deps: { db: Db }): Hono {
  const { db } = deps;
  const r = new Hono();

  // 組み立て結果を返すだけ (送信しない)。 設定確認・出力確認用。
  r.get('/api/briefing/preview', async (c) => {
    const cfg = getBriefingConfig(db);
    const briefing = await buildBriefing(db, cfg);
    return c.json({
      generatedAt: briefing.generatedAt.toISOString(),
      blocks: briefing.blocks,
      discord: formatForDiscord(briefing),
      hora: formatForHora(briefing),
    });
  });

  // 今すぐ Discord / Hora に投稿する (テスト送信)。 enabled / 稼働時間帯は無視する。
  r.post('/api/briefing/test', async (c) => {
    const cfg = getBriefingConfig(db);
    const briefing = await buildBriefing(db, cfg);
    let discordPosted = false;
    let horaPosted = false;
    if (cfg.toDiscord && discordClientReady()) {
      discordPosted = await postBriefingToDiscord(db, formatForDiscord(briefing));
    }
    if (cfg.hora.enabled && cfg.hora.url) {
      horaPosted = await postBriefingToHora(cfg.hora.url, formatForHora(briefing));
    }
    return c.json({ ok: true, sections: briefing.blocks.length, discordPosted, horaPosted });
  });

  return r;
}
