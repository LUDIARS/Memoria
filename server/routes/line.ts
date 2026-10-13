// LINE 送信の設定 API。 トークンは受け取るが返さない (token_set の真偽だけ)。

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { requireScope } from '../lib/scoped-access.js';
import { lineSettings, lineSettingsView, updateLineSettings, type LineSettingsPatch } from '../line/settings.js';
import { pushLineText, type FetchLike } from '../line/client.js';

type Db = BetterSqlite3.Database;

export interface LineRouterDeps {
  db: Db;
  /** テスト用の差し替え口。 */
  fetchImpl?: FetchLike;
}

export function makeLineRouter({ db, fetchImpl }: LineRouterDeps): Hono {
  const r = new Hono();
  r.use('/api/line/*', requireScope('admin'));

  r.get('/api/line/settings', (c: Context) => c.json(lineSettingsView(db)));

  r.put('/api/line/settings', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as LineSettingsPatch;
    const res = updateLineSettings(db, body);
    if (!res.ok) return c.json({ ok: false, reason: res.reason }, 400);
    return c.json({ ok: true, ...lineSettingsView(db) });
  });

  r.post('/api/line/test', async (c: Context) => {
    const { token, to } = lineSettings(db);
    const res = await pushLineText({ token, to, text: '🔔 Memoria からのテスト送信です' }, fetchImpl);
    return c.json({ ok: res.ok, reason: res.reason ?? null }, res.ok ? 200 : 409);
  });

  return r;
}
