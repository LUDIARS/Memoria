// Discord 設定 API。 設定画面の「Discord」セクションが読み書きする。
// token は返さない / 受け取らない (env 管理)。 opt-out は app_settings に保存。

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';
import { discordSettings, discordReady, discordBotToken } from '../discord/settings.js';
import { announceToDiscord, fireNotifyTriggerById } from '../discord/index.js';
import { loadTriggers, saveTriggers, normalizeTriggers } from '../discord/notify/config.js';
import { NOTIFY_CHANNEL_KINDS } from '../discord/notify/types.js';

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
    return c.json({ config: cfg, token_set: !!discordBotToken(db), ready: ready.ok, reason: ready.reason });
  });

  // opt-out / self/guild / token の更新。 反映は次回 capture / Bot 再起動から。
  // token は空文字なら据え置き (パスワード UX)、 非空なら上書き保存。
  r.patch('/api/discord/config', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [field, key] of Object.entries(BOOL_KEYS)) {
      if (field in body) patch[key] = body[field] ? '1' : '0';
    }
    for (const [field, key] of Object.entries(STRING_KEYS)) {
      if (field in body && typeof body[field] === 'string') patch[key] = (body[field] as string).trim();
    }
    if (typeof body.botToken === 'string' && body.botToken.trim()) {
      patch['features.discord.bot_token'] = body.botToken.trim();
    }
    if (Object.keys(patch).length > 0) setAppSettings(db, patch);
    return c.json({ ok: true, config: discordSettings(db), token_set: !!discordBotToken(db) });
  });

  // 通知トリガー一覧 + UI 用の選択肢 (登録カテゴリ / channel kind)。
  r.get('/api/discord/notify-triggers', (c: Context) => {
    let categories: string[] = [];
    try {
      const raw = getAppSettings(db)['task.categories.registered'];
      if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) categories = a.filter((x): x is string => typeof x === 'string'); }
    } catch { /* ignore */ }
    return c.json({ triggers: loadTriggers(db), categories, channels: NOTIFY_CHANNEL_KINDS });
  });

  // トリガー配列を丸ごと保存 (UI で編集して PUT)。 normalize で型矯正。
  r.put('/api/discord/notify-triggers', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { triggers?: unknown };
    const arr = Array.isArray(body.triggers) ? body.triggers : [];
    const triggers = normalizeTriggers(arr);
    saveTriggers(db, triggers);
    return c.json({ ok: true, triggers });
  });

  // 1 トリガーを即時発火 (動作確認)。 該当 0 件でも送る。
  r.post('/api/discord/notify-triggers/:id/test', async (c: Context) => {
    const id = c.req.param('id') || '';
    const res = await fireNotifyTriggerById(db, id);
    if (!res.ok) return c.json({ ok: false, reason: res.reason }, res.reason === 'not_found' ? 404 : 409);
    return c.json({ ok: true, count: res.count ?? 0 });
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
