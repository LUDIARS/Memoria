// 定期ブリーフィングを #briefing に「1 件だけ」 保つ投稿ロジック。
// 毎回新規投稿するとチャンネルが流れてしまうため、 前回のメッセージを
//   - チャンク数が同じなら edit で上書き
//   - 違う(or 前回が無い)なら 旧メッセージを削除して新規投稿
// する。 投稿した message id 群は app_settings に保存して次回参照する。

import { ChannelType, type Client, type TextChannel } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';
import { channelIdFor } from './layout.js';

type Db = BetterSqlite3.Database;

const IDS_KEY = 'briefing.discord.message_ids';
const CH_KEY = 'briefing.discord.channel_id';
const MAX_LEN = 1900;

function loadOldIds(db: Db, channelId: string): string[] {
  const s = getAppSettings(db);
  if (s[CH_KEY] !== channelId) return []; // チャンネルが変わったら旧 id は無効
  try {
    const arr = JSON.parse(s[IDS_KEY] || '[]') as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveIds(db: Db, channelId: string, ids: string[]): void {
  setAppSettings(db, { [CH_KEY]: channelId, [IDS_KEY]: JSON.stringify(ids) });
}

/**
 * #briefing にブリーフィングを 1 件に集約して投稿する。 best-effort。
 * 戻り値: 実際に投稿/更新できたら true。
 */
export async function postRollingBriefing(client: Client, db: Db, parts: string[]): Promise<boolean> {
  const trimmed = parts.map((p) => p.slice(0, MAX_LEN)).filter((p) => p.length > 0);
  if (!trimmed.length) return false;

  const channelId = channelIdFor(db, 'briefing');
  if (!channelId) return false;

  let channel: TextChannel;
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || ch.type !== ChannelType.GuildText) return false;
    channel = ch as TextChannel;
  } catch {
    return false;
  }

  const oldIds = loadOldIds(db, channelId);

  // チャンク数が一致 → in-place 編集を試みる。 1 つでも失敗したら削除+再投稿に倒す。
  if (oldIds.length === trimmed.length) {
    let allEdited = true;
    for (let i = 0; i < trimmed.length; i++) {
      try {
        await channel.messages.edit(oldIds[i], trimmed[i]);
      } catch {
        allEdited = false;
        break;
      }
    }
    if (allEdited) {
      saveIds(db, channelId, oldIds);
      return true;
    }
  }

  // 旧メッセージを削除 (best-effort) してから新規投稿。
  for (const id of oldIds) {
    try {
      await channel.messages.delete(id);
    } catch {
      // 既に消えている / 権限不足などは無視
    }
  }

  const newIds: string[] = [];
  try {
    for (const part of trimmed) {
      const msg = await channel.send(part);
      newIds.push(msg.id);
    }
  } catch {
    // 途中失敗でも送れた分の id は保存しておく (次回それらを掃除できる)
    if (newIds.length) saveIds(db, channelId, newIds);
    return newIds.length > 0;
  }

  saveIds(db, channelId, newIds);
  return true;
}
