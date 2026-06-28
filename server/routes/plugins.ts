// ユーザーアプリ (プラグインホスト) との接続 API。
// - GET  /api/plugins         : ホスト manifest を取得してフロントに返す
// - GET  /api/plugins/config  : 接続設定 (URL / トークン有無)
// - POST /api/plugins/config  : 接続設定の更新
// - POST /api/plugins/announce: プラグインからの announce を #announce に流す seam
//
// announce は Discord 投稿を起こすため、 共有トークン (plugins.api_token) で認可する。

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { getPluginHostConfig, setPluginHostConfig } from '../plugins/store.js';
import { fetchManifest } from '../plugins/client.js';
import { announceToDiscord } from '../discord/index.js';

type Db = BetterSqlite3.Database;

export interface PluginsRouterDeps {
  db: Db;
}

export function makePluginsRouter(deps: PluginsRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  r.get('/api/plugins', async (c: Context) => {
    const cfg = getPluginHostConfig(db);
    const manifest = await fetchManifest(cfg.hostUrl);
    return c.json({ host_url: cfg.hostUrl, ...manifest });
  });

  r.get('/api/plugins/config', (c: Context) => {
    const cfg = getPluginHostConfig(db);
    return c.json({ host_url: cfg.hostUrl, api_token_set: Boolean(cfg.apiToken) });
  });

  r.post('/api/plugins/config', async (c: Context) => {
    const body = (await c.req.json()) as { host_url?: unknown; api_token?: unknown };
    const patch: { hostUrl?: string; apiToken?: string } = {};
    if (typeof body.host_url === 'string') patch.hostUrl = body.host_url;
    // 空文字トークンは「変更なし」 扱い (既存維持)。
    if (typeof body.api_token === 'string' && body.api_token !== '') patch.apiToken = body.api_token;
    setPluginHostConfig(db, patch);
    return c.json({ ok: true });
  });

  r.post('/api/plugins/announce', async (c: Context) => {
    const cfg = getPluginHostConfig(db);
    if (!cfg.apiToken) {
      return c.json({ ok: false, error: 'plugins.api_token 未設定のため拒否' }, 403);
    }
    if (c.req.header('x-plugin-token') !== cfg.apiToken) {
      return c.json({ ok: false, error: 'トークン不一致' }, 401);
    }
    const body = (await c.req.json()) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return c.json({ ok: false, error: 'text が空' }, 400);
    await announceToDiscord(db, text);
    return c.json({ ok: true });
  });

  return r;
}
