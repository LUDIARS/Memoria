// ユーザーアプリ一覧 API。
//
// プラグインは本体プロセスに in-process マウント済み (server/plugins/host.ts)。
// ここはマウント結果の manifest (相対 url /plugins/<id>) を UI に返すだけ。
// 旧サイドカー接続 (host_url / api_token) と announce seam は廃止
// (announce は in-process で announceToDiscord を直接呼ぶ)。

import { Hono, type Context } from 'hono';
import type { PluginManifestEntry } from '../plugins/memoria-plugin/host/types.js';

export interface PluginsRouterDeps {
  /** mountUserApps() が返したマウント済みプラグインの manifest。 */
  manifest: PluginManifestEntry[];
}

export function makePluginsRouter(deps: PluginsRouterDeps): Hono {
  const r = new Hono();

  r.get('/api/plugins', (c: Context) => c.json({ ok: true, plugins: deps.manifest }));

  return r;
}
