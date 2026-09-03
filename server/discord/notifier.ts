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

/** 指定 kind (例 'announce') の channel にテキストを送る。 成功したときだけ true。 */
export async function postToChannel(client: Client, db: Db, kind: string, content: string): Promise<boolean> {
  const id = channelIdFor(db, kind);
  if (!id) return false;
  const selfUserId = discordSettings(db).selfUserId;
  try {
    const ch = await client.channels.fetch(id);
    if (ch && ch.type === ChannelType.GuildText) {
      await ch.send({
        content: content.slice(0, 1900),
        // 外部フィードや書誌の `@everyone` は展開せず、設定済みの本人だけ許可する。
        allowedMentions: { parse: [], users: selfUserId ? [selfUserId] : [] },
      });
      return true;
    }
    return false;
  } catch {
    // best-effort — 送信失敗は本筋を止めない
    return false;
  }
}

/** アナウンス (= 既存の通知系) を #announce に投稿。 mention_notify ON なら self メンション付き。 */
export async function postAnnouncement(client: Client, db: Db, text: string): Promise<boolean> {
  const cfg = discordSettings(db);
  if (!cfg.announce) return false;
  const prefix = cfg.mentionNotify ? `${selfMention(db)} ` : '';
  return postToChannel(client, db, 'announce', `${prefix}📢 ${text}`);
}
