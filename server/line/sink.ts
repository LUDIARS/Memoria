// 共通の通知送り先 (shared/notify-sink) に LINE を登録する。 設定は送信のたびに読む (保存直後から効く)。

import type BetterSqlite3 from 'better-sqlite3';
import { registerNotifySink } from '../shared/notify-sink.js';
import { lineSettings } from './settings.js';
import { pushLineText } from './client.js';

type Db = BetterSqlite3.Database;

export function registerLineSink(db: Db): void {
  registerNotifySink('line', async (destination, text) => {
    if (destination.kind !== 'line') return false;
    const { token, to } = lineSettings(db);
    const res = await pushLineText({ token, to, text });
    if (!res.ok) console.warn(`[line] push failed: ${res.reason ?? res.status}`);
    return res.ok;
  });
}
