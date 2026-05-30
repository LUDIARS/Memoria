// Discord 設定 API。 設定画面の「Discord」セクションが読み書きする。
// token は返さない / 受け取らない (env 管理)。 opt-out は app_settings に保存。

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { setAppSettings } from '../db.js';
import { discordSettings, discordReady, discordBotToken } from '../discord/settings.js';
import { announceToDiscord } from '../discord/index.js';

type Db = BetterSqlite3.Database;

export interface DiscordRouterDeps { db: Db; }

// PATCH で受け付ける bool キー (settings key ← camelCase フィールド)。
const BOOL_KEYS: Record<string, string> = {
  enabled: 'features.discord.enabled',
  captureMessage: 'features.discord.capture.message',
  capturePresence: 'features.discord.capture.presence',
  captureVoice: 'features.discord.capture.voice',
  captureReaction: 'features.discord.capture.reaction',
  aiProcess: 'features.discord.ai_process',
  mentionNotify: 'features.discord.mention_notify',
  announce: 'features.discord.announce',
  autoTask: 'features.discord.autoproc.task',
  autoMemo: 'features.discord.autoproc.memo',
  autoBookmark: 'features.discord.autoproc.bookmark',
  autoMeal: 'features.discord.autoproc.meal',
  autoRecommend: 'features.discord.autoproc.recommend',
};
const STRING_KEYS: Record<string, string> = {
  selfUserId: 'features.discord.self_user_id',
  guildId: 'features.discord.guild_id',
};

export function makeDiscordRouter(deps: DiscordRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  // 現在の設定 + 接続可否。 token 値は出さず「設定済みか」だけ返す。
  r.get('/api/discord/config', (c: Context) => {
    const cfg = discordSettings(db);
    const ready = discordReady(db);
    return c.json({ config: cfg, token_set: !!discordBotToken(), ready: ready.ok, reason: ready.reason });
  });

  // opt-out / self/guild の更新。 反映は次回 capture / Bot 再起動から。
  r.patch('/api/discord/config', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [field, key] of Object.entries(BOOL_KEYS)) {
      if (field in body) patch[key] = body[field] ? '1' : '0';
    }
    for (const [field, key] of Object.entries(STRING_KEYS)) {
      if (field in body && typeof body[field] === 'string') patch[key] = (body[field] as string).trim();
    }
    if (Object.keys(patch).length > 0) setAppSettings(db, patch);
    return c.json({ ok: true, config: discordSettings(db) });
  });

  // 通知を Discord #announce に流す seam (テスト / 外部トリガ用)。
  r.post('/api/discord/announce', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { text?: unknown };
    const text = String(body.text ?? '').trim();
    if (!text) return c.json({ error: 'text required' }, 400);
    await announceToDiscord(db, text);
    return c.json({ ok: true });
  });

  return r;
}
