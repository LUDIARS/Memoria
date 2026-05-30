// 行動ログ取得。 self のメッセージ / プレゼンス / ボイス / リアクションを
// activity_events に記録する。 各 capture はオプトアウトで個別 OFF 可。
// 設定変更を即反映するため、 イベントごとに discordSettings(db) を読み直す。
//
// 個人データ: 本文等は Memoria local にのみ保存 (RULE §5)。 識別情報は持たない。

import type { Client, Message, PartialMessage } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { recordActivityEvent } from '../db.js';
import { discordSettings } from './settings.js';
import { isSelf } from './user-map.js';

type Db = BetterSqlite3.Database;

const CONTENT_MAX = 1000;

function record(db: Db, kind: Parameters<typeof recordActivityEvent>[1]['kind'], refId: string, content: string, metadata: Record<string, unknown>): void {
  try {
    recordActivityEvent(db, {
      kind,
      ref_id: refId,
      source: 'discord',
      content: content.slice(0, CONTENT_MAX),
      metadata,
    });
  } catch {
    // best-effort — 取得失敗は本筋 (Memoria server) を止めない
  }
}

/** Client にキャプチャ用リスナーを登録する。 enabled な capture のみ記録。 */
export function registerCapture(client: Client, db: Db): void {
  client.on('messageCreate', (msg: Message) => {
    const cfg = discordSettings(db);
    if (!cfg.captureMessage || msg.author?.bot || !isSelf(cfg, msg.author?.id)) return;
    record(db, 'discord_message', msg.id, msg.content ?? '', {
      channel_id: msg.channelId,
      channel_name: 'name' in msg.channel ? msg.channel.name : null,
      attachments: msg.attachments.size,
      has_url: /https?:\/\//.test(msg.content ?? ''),
    });
  });

  client.on('presenceUpdate', (_old, next) => {
    const cfg = discordSettings(db);
    if (!cfg.capturePresence || !isSelf(cfg, next.userId)) return;
    const activities = next.activities.map((a) => ({ name: a.name, type: a.type, state: a.state ?? null, details: a.details ?? null }));
    record(db, 'discord_presence', `${next.userId}:${Date.now()}`, next.status, {
      status: next.status,
      client_status: next.clientStatus ?? null,
      activities,
    });
  });

  client.on('voiceStateUpdate', (oldState, newState) => {
    const cfg = discordSettings(db);
    const userId = newState.member?.id ?? oldState.member?.id;
    if (!cfg.captureVoice || !isSelf(cfg, userId)) return;
    const action = !oldState.channelId && newState.channelId ? 'join'
      : oldState.channelId && !newState.channelId ? 'leave'
        : 'update';
    record(db, 'discord_voice', `${userId}:${Date.now()}`, action, {
      action,
      from_channel: oldState.channelId,
      to_channel: newState.channelId,
      self_mute: newState.selfMute,
      self_deaf: newState.selfDeaf,
      streaming: newState.streaming,
      self_video: newState.selfVideo,
    });
  });

  client.on('messageReactionAdd', (reaction, user) => {
    const cfg = discordSettings(db);
    if (!cfg.captureReaction || !isSelf(cfg, user.id)) return;
    const msg: Message | PartialMessage = reaction.message;
    record(db, 'discord_reaction', `${user.id}:${msg.id}:${reaction.emoji.name ?? ''}`, reaction.emoji.name ?? '', {
      message_id: msg.id,
      channel_id: msg.channelId,
      emoji: reaction.emoji.name ?? reaction.emoji.id,
    });
  });
}
