// self 判定。 個人サーバーでも複数人いる場合に、 設定した自分の Discord user id の
// イベントだけをログ対象にする (混入・取りこぼし防止)。識別情報の正本は Cernere な
// ので、 ここでは id の一致判定のみ行い氏名等は保持しない (RULE §5)。

import type { DiscordSettings } from './settings.js';

/** userId が設定された self_user_id と一致するか。 self 未設定なら常に false。 */
export function isSelf(cfg: DiscordSettings, userId: string | null | undefined): boolean {
  if (!cfg.selfUserId) return false;
  return userId === cfg.selfUserId;
}
