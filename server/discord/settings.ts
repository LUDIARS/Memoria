// Discord 機能の設定読み出し。 privacy.ts と同じく app_settings から正規化して返す。
// すべて opt-out 可。 token だけは DB に置かず env (サービスシークレット)。

import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings } from '../db.js';
import { settingBool } from '../lib/privacy.js';

type Db = BetterSqlite3.Database;

export interface DiscordSettings {
  /** マスタ。 OFF なら Bot 自体を起動しない (明示 opt-in、 既定 false)。 */
  enabled: boolean;
  /** ログ対象の自分の Discord user id。 複数人サーバーで取りこぼし/混入を防ぐため必須。 */
  selfUserId: string;
  /** 対象サーバー (guild) id。 layout 生成・capture のスコープ。 */
  guildId: string;
  // capture 群 (既定 true)
  captureMessage: boolean;
  capturePresence: boolean;
  captureVoice: boolean;
  captureReaction: boolean;
  // 処理 / 出力 (既定 true)
  aiProcess: boolean;
  mentionNotify: boolean;
  announce: boolean;
  // 各自動処理 (既定 true)
  autoTask: boolean;
  autoMemo: boolean;
  autoBookmark: boolean;
  autoMeal: boolean;
  autoRecommend: boolean;
}

/**
 * Bot token。 Memoria の設定 (app_settings) を優先し、 無ければ env を見る。
 * Memoria はローカル SQLite に閉じる個人アプリで、 既に OpenAI key 等を設定保存
 * しているため同パターン。 値は GET API / フロント / ログには決して出さない
 * (token_set の bool のみ公開)。
 */
export function discordBotToken(db?: Db): string {
  if (db) {
    const t = getAppSettings(db)['features.discord.bot_token'];
    if (t) return t;
  }
  return process.env.MEMORIA_DISCORD_BOT_TOKEN ?? '';
}

export function discordSettings(db: Db): DiscordSettings {
  const s = getAppSettings(db);
  return {
    enabled: settingBool(s, 'features.discord.enabled', false),
    selfUserId: s['features.discord.self_user_id'] || '',
    guildId: s['features.discord.guild_id'] || '',
    captureMessage: settingBool(s, 'features.discord.capture.message', true),
    capturePresence: settingBool(s, 'features.discord.capture.presence', true),
    captureVoice: settingBool(s, 'features.discord.capture.voice', true),
    captureReaction: settingBool(s, 'features.discord.capture.reaction', true),
    aiProcess: settingBool(s, 'features.discord.ai_process', true),
    mentionNotify: settingBool(s, 'features.discord.mention_notify', true),
    announce: settingBool(s, 'features.discord.announce', true),
    autoTask: settingBool(s, 'features.discord.autoproc.task', true),
    autoMemo: settingBool(s, 'features.discord.autoproc.memo', true),
    autoBookmark: settingBool(s, 'features.discord.autoproc.bookmark', true),
    autoMeal: settingBool(s, 'features.discord.autoproc.meal', true),
    autoRecommend: settingBool(s, 'features.discord.autoproc.recommend', true),
  };
}

/** 起動可能か (マスタ ON + token + self + guild が揃っているか)。 */
export function discordReady(db: Db): { ok: boolean; reason: string } {
  const cfg = discordSettings(db);
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  if (!discordBotToken(db)) return { ok: false, reason: 'Bot token 未設定' };
  if (!cfg.selfUserId) return { ok: false, reason: 'self_user_id 未設定' };
  if (!cfg.guildId) return { ok: false, reason: 'guild_id 未設定' };
  return { ok: true, reason: '' };
}
