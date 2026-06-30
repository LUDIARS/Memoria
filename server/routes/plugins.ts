// ユーザーアプリ一覧 + 操作 API。
//
// プラグインは本体プロセスに in-process マウント済み (server/plugins/host.ts)。
//  - GET  /api/plugins                … マウント済み manifest (status 含む) を返す。
//  - POST /api/plugins/:id/reload     … プラグイン単体をホットリロード。
//  - GET  /api/plugins/:id/trends     … 傾向系列 (グラフ用) を返す。
// 旧サイドカー接続 (host_url / api_token) は廃止 (announce は in-process 直呼び)。

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import type { PluginRegistry } from '../plugins/memoria-plugin/host/registry.js';
import { listPluginTrends, listPluginTrendSeries } from '../plugins/framework-store.js';

type Db = BetterSqlite3.Database;

export interface PluginsRouterDeps {
  db: Db;
  /** mountUserApps() が返した registry (manifest / reload)。 */
  registry: PluginRegistry;
}

export function makePluginsRouter(deps: PluginsRouterDeps): Hono {
  const r = new Hono();
  const { db, registry } = deps;

  r.get('/api/plugins', (c: Context) => c.json({ ok: true, plugins: registry.manifest() }));

  r.post('/api/plugins/:id/reload', async (c: Context) => {
    const id = c.req.param('id');
    if (!id) return c.json({ ok: false, error: 'missing plugin id' }, 400);
    const updated = await registry.reload(id);
    if (!updated) return c.json({ ok: false, error: 'unknown plugin' }, 404);
    return c.json({ ok: true, plugin: updated });
  });

  r.get('/api/plugins/:id/trends', (c: Context) => {
    const id = c.req.param('id');
    if (!id) return c.json({ ok: false, error: 'missing plugin id' }, 400);
    const series = c.req.query('series') || undefined;
    const sinceIso = c.req.query('since') || undefined;
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const points = listPluginTrends(db, { pluginId: id, series, sinceIso, limit });
    return c.json({ ok: true, series: listPluginTrendSeries(db, id), points });
  });

  return r;
}
