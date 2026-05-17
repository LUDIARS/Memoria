// multi-proxy — Multi モード時、 ローカル backend を Hub と mix する層。
//
// 二層設計 (spec/feature/multi-hub.md §5.3) の proxy 層。 frontend は常に
// localhost:5180 に話すが、 Multi モードのときは:
//   - Multi 対応 7 型の **list** パス  → Local の結果 + Hub /api/data/* を mix
//   - Multi 対応 7 型の **detail** パス → Hub の /api/data/* に転送 (= 旧 proxy)
//   - 個人ログ系のパス                 → 503 { error: 'local_only' }
//   - それ以外 (制御系・インフラ系)     → そのまま local routes に通す
//
// mix-list: 各 item に
//   `_origin: 'local' | 'hub'`              — 物理上どこから来たか
//   `owner_user_id: string | null`           — Hub 上の所有者 (local item は null)
//   `owner_user_name: string | null`         — 表示名 (local item は null)
//   `shared_at: string | null`               — Hub に publish された ISO 時刻 (Local も保持)
// を付与する。 frontend はこれを使って 「自分 / 他ユーザ / 未シェア」 を判別する。
//
// Local モードのときは何もせず素通り (= 従来どおり SQLite 直)。

import type { Context, Next } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { readMode, readMultiServers, findServerByUrl, hubFetch } from './multi-client.js';

type Db = BetterSqlite3.Database;

type MapResult =
  | { kind: 'mix-list'; hubPath: string }
  | { kind: 'proxy'; hubPath: string }
  | { kind: 'local-only' }
  | { kind: 'passthrough' };

// ローカルの feature パス → Hub /api/data/<type> の対応。
//   list (= base path) は mix-list、 detail (= /:id) は proxy。
// Multi 対応型でも、 ここに無い sub-path (/api/bookmarks/:id/html 等) は
// passthrough になる。 frontend (Phase 5) が Multi モードでは出さない前提。
function mapToHub(path: string): MapResult {
  let m: RegExpExecArray | null;

  // ── Multi 対応 7 型 ──
  // bookmarks
  if (/^\/api\/bookmarks$/.test(path)) return { kind: 'mix-list', hubPath: '/api/data/bookmarks' };
  if (/^\/api\/bookmark$/.test(path)) return { kind: 'mix-list', hubPath: '/api/data/bookmarks' };
  if ((m = /^\/api\/bookmarks\/(\d+)$/.exec(path))) return { kind: 'proxy', hubPath: `/api/data/bookmarks/${m[1]}` };
  // dig
  if (/^\/api\/dig$/.test(path)) return { kind: 'mix-list', hubPath: '/api/data/digs' };
  if ((m = /^\/api\/dig\/(\d+)$/.exec(path))) return { kind: 'proxy', hubPath: `/api/data/digs/${m[1]}` };
  // dictionary
  if (/^\/api\/dictionary$/.test(path)) return { kind: 'mix-list', hubPath: '/api/data/dictionary' };
  if ((m = /^\/api\/dictionary\/(\d+)$/.exec(path))) return { kind: 'proxy', hubPath: `/api/data/dictionary/${m[1]}` };
  // implementation-notes
  if (/^\/api\/implementation-notes$/.test(path)) return { kind: 'mix-list', hubPath: '/api/data/implementation-notes' };
  if ((m = /^\/api\/implementation-notes\/(\d+)$/.exec(path))) {
    return { kind: 'proxy', hubPath: `/api/data/implementation-notes/${m[1]}` };
  }
  // work-locations
  if (/^\/api\/work-locations$/.test(path)) return { kind: 'mix-list', hubPath: '/api/data/work-locations' };
  if ((m = /^\/api\/work-locations\/(\d+)$/.exec(path))) {
    return { kind: 'proxy', hubPath: `/api/data/work-locations/${m[1]}` };
  }
  // domain-catalog (ローカルは domain をキーにするが Hub は id。 list のみ確実に対応)
  if (/^\/api\/domains$/.test(path)) return { kind: 'mix-list', hubPath: '/api/data/domain-catalog' };
  if ((m = /^\/api\/domains\/(\d+)$/.exec(path))) return { kind: 'proxy', hubPath: `/api/data/domain-catalog/${m[1]}` };
  // notes (uuid)
  if (/^\/api\/notes$/.test(path)) return { kind: 'mix-list', hubPath: '/api/data/notes' };
  if ((m = /^\/api\/notes\/([0-9a-fA-F-]{8,})$/.exec(path))) {
    return { kind: 'proxy', hubPath: `/api/data/notes/${m[1]}` };
  }

  // ── 個人ログ系 = ローカル専用 (Hub には出さない、 [個人データ保管禁止]) ──
  // worklog / worklist (= tasks / repo dashboard) / packet-monitor も Hub には
  // 対応 endpoint が無いので Multi モードでは local_only。 frontend 側でタブが
  // mode-locked になるので通常は呼ばれないが、 念のためサーバ側でもガード。
  if (/^\/api\/(diary|weekly|meals|locations|tracks|legatus|visits|trends|recommendations|activity|weather|transit|review|work-sessions|wifi|worklog|repos|tasks|packet-monitor)(\/|$)/.test(path)) {
    return { kind: 'local-only' };
  }

  // ── それ以外 (制御系 /api/multi/*・/api/setup/*、 インフラ系、 および
  //    Multi 対応型の未対応 sub-path) は local に素通し ──
  return { kind: 'passthrough' };
}

// Local item に 「自分の所有 / 未シェア」 を表すメタを乗せる。
// Local DB には owner 概念が無いので、 _origin='local' + owner_user_id=null と
// しておき、 frontend が 「未シェア」 と 「自分の (Hub に上げ済)」 を shared_at の
// 有無で判別する。
function tagLocalItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    ...item,
    _origin: 'local',
    owner_user_id: item.owner_user_id ?? null,
    owner_user_name: item.owner_user_name ?? null,
  };
}

function tagHubItem(item: Record<string, unknown>): Record<string, unknown> {
  return { ...item, _origin: 'hub' };
}

export function makeMultiProxyMiddleware(db: Db) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const path = c.req.path;
    if (!path.startsWith('/api/')) return next();
    // 制御系は常に local が処理する (モード切替・セットアップ自体は Hub に出せない)。
    if (path.startsWith('/api/multi/') || path.startsWith('/api/setup/')) return next();

    const { mode, hubUrl } = readMode(db);
    if (mode !== 'multi' || !hubUrl) return next();

    const mapped = mapToHub(path);
    if (mapped.kind === 'passthrough') return next();
    if (mapped.kind === 'local-only') {
      return c.json({ error: 'local_only', mode: 'multi' }, 503);
    }

    // 認証 Hub を取り出す
    const { servers } = readMultiServers(db);
    const server = findServerByUrl(servers, hubUrl);
    if (!server || !server.jwt) {
      return c.json({ error: 'hub_not_logged_in', mode: 'multi' }, 503);
    }

    const qs = new URL(c.req.url).search;
    const method = c.req.method;

    // ── mix-list: Local 先行で next() → 結果を取り出し、 Hub を fetch、 merge ──
    if (mapped.kind === 'mix-list' && method === 'GET') {
      await next();
      // c.res は local handler が build した Response。 ok なら body を merge。
      const localRes = c.res;
      let localItems: Array<Record<string, unknown>> = [];
      if (localRes && localRes.ok) {
        try {
          const j = await localRes.clone().json() as { items?: unknown };
          if (Array.isArray(j.items)) localItems = j.items as Array<Record<string, unknown>>;
        } catch { /* local 応答が JSON でない (e.g. HTML) なら空扱い */ }
      }

      let hubItems: Array<Record<string, unknown>> = [];
      try {
        const r = await hubFetch(server.url, server.jwt, mapped.hubPath + qs, { method: 'GET' });
        // hubFetch の body は raw string か parsed object。 両対応。
        const hb = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
        if (hb && Array.isArray(hb.items)) hubItems = hb.items as Array<Record<string, unknown>>;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[multi-proxy] hub list fetch failed:', msg);
        // Hub が落ちていても local だけで返したい
      }

      const tagged = [
        ...localItems.map(tagLocalItem),
        ...hubItems.map(tagHubItem),
      ];

      // sort: created_at DESC、 無ければ shared_at DESC
      tagged.sort((a, b) => {
        const ka = String(a.created_at || a.shared_at || a.updated_at || '');
        const kb = String(b.created_at || b.shared_at || b.updated_at || '');
        return ka < kb ? 1 : ka > kb ? -1 : 0;
      });

      c.res = new Response(JSON.stringify({ items: tagged, _mix: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      return;
    }

    // ── proxy: 旧来通り Hub に forward (detail / write 系) ──
    const init: { method: string; body?: string } = { method };
    if (method !== 'GET' && method !== 'HEAD') {
      init.body = await c.req.text();
    }

    try {
      const r = await hubFetch(server.url, server.jwt, mapped.hubPath + qs, init);
      const payload = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      return new Response(payload, {
        status: r.status,
        headers: { 'Content-Type': r.contentType },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `hub proxy failed: ${msg}` }, 502);
    }
  };
}
