// LINE Messaging API の設定 (app_settings)。
// チャネルアクセストークンは Discord Bot token と同じく DB に置き、 API / フロント / ログへは token_set の真偽しか出さない。

import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';

type Db = BetterSqlite3.Database;

const KEY_TOKEN = 'features.line.channel_access_token';
const KEY_TO = 'features.line.to';

export interface LineSettings {
  token: string;
  /** 送り先のユーザー ID (U...) / グループ ID (C...) / ルーム ID (R...)。 */
  to: string;
}

export interface LineSettingsView {
  token_set: boolean;
  to: string;
}

export function lineSettings(db: Db): LineSettings {
  const s = getAppSettings(db);
  return { token: (s[KEY_TOKEN] ?? '').trim(), to: (s[KEY_TO] ?? '').trim() };
}

export function lineSettingsView(db: Db): LineSettingsView {
  const { token, to } = lineSettings(db);
  return { token_set: token.length > 0, to };
}

/** LINE の送り先 ID の形 (U/C/R + 32 桁 16 進)。 */
export function isValidLineTargetId(id: string): boolean {
  return /^[UCR][0-9a-f]{32}$/.test(id);
}

export interface LineSettingsPatch {
  /** 未指定・空文字は据え置き。 clearToken=true で消す。 */
  token?: unknown;
  clearToken?: unknown;
  to?: unknown;
}

/** 入力を検証して保存する。 不正なら理由を返して何も保存しない。 */
export function updateLineSettings(db: Db, patch: LineSettingsPatch): { ok: true } | { ok: false; reason: string } {
  const next: Record<string, string> = {};
  if (patch.clearToken === true) {
    next[KEY_TOKEN] = '';
  } else if (typeof patch.token === 'string' && patch.token.trim()) {
    next[KEY_TOKEN] = patch.token.trim();
  }
  if (typeof patch.to === 'string') {
    const to = patch.to.trim();
    if (to && !isValidLineTargetId(to)) {
      return { ok: false, reason: '送り先 ID は U / C / R で始まる 33 文字の ID を入れてください' };
    }
    next[KEY_TO] = to;
  }
  if (Object.keys(next).length) setAppSettings(db, next);
  return { ok: true };
}
