// Discord への送信抽象。 直送 (discord.js client) で実装。 将来 Nuntius 経由に
// 切り替える場合もこのモジュールだけ差し替えれば済むようにする。

import { ChannelType, type Client } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { discordSettings } from './settings.js';
import { channelIdFor } from './layout.js';

type Db = BetterSqlite3.Database;

/** self メンション文字列 (`<@id>`)。 self 未設定なら空。 */
export function selfMention(db: Db): string {
  const id = discordSettings(db).selfUserId;
  return id ? `<@${id}>` : '';
}

/** 指定 kind (例 'announce') の channel にテキストを送る。 best-effort。 */
export async function postToChannel(client: Client, db: Db, kind: string, content: string): Promise<void> {
  const id = channelIdFor(db, kind);
  if (!id) return;
  try {
    const ch = await client.channels.fetch(id);
    if (ch && ch.type === ChannelType.GuildText) {
      await ch.send(content.slice(0, 1900));
    }
  } catch {
    // best-effort — 送信失敗は本筋を止めない
  }
}

/** アナウンス (= 既存の通知系) を #announce に投稿。 mention_notify ON なら self メンション付き。 */
export async function postAnnouncement(client: Client, db: Db, text: string): Promise<void> {
  const cfg = discordSettings(db);
  if (!cfg.announce) return;
  const prefix = cfg.mentionNotify ? `${selfMention(db)} ` : '';
  await postToChannel(client, db, 'announce', `${prefix}📢 ${text}`);
}
