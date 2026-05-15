// multi-proxy — Multi モード時、 ローカル backend を Hub の DB 代理にする。
//
// 二層設計 (spec/feature/multi-hub.md §5.3) の proxy 層。 frontend は常に
// localhost:5180 に話すが、 Multi モードのときは:
//   - Multi 対応 7 型の CRUD パス  → Hub の /api/data/* に転送
//   - 個人ログ系のパス             → 503 { error: 'local_only' }
//   - それ以外 (制御系・インフラ系) → そのまま local routes に通す
//
// Local モードのときは何もせず素通り (= 従来どおり SQLite 直)。

import type { Context, Next } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { readMode, readMultiServers, findServerByUrl, hubFetch } from './multi-client.js';

type Db = BetterSqlite3.Database;

type MapResult =
  | { kind: 'proxy'; hubPath: string }
  | { kind: 'local-only' }
  | { kind: 'passthrough' };

// ローカルの feature パス → Hub /api/data/<type> の対応。
// Multi 対応型でも、 ここに無い sub-path (/api/bookmarks/:id/html 等) は
// passthrough になる。 frontend (Phase 5) が Multi モードでは出さない前提。
function mapToHub(path: string): MapResult {
  let m: RegExpExecArray | null;

  // ── Multi 対応 7 型の基本 CRUD ──
  // bookmarks
  if (/^\/api\/bookmarks$/.test(path)) return { kind: 'proxy', hubPath: '/api/data/bookmarks' };
  if (/^\/api\/bookmark$/.test(path)) return { kind: 'proxy', hubPath: '/api/data/bookmarks' };
  if ((m = /^\/api\/bookmarks\/(\d+)$/.exec(path))) return { kind: 'proxy', hubPath: `/api/data/bookmarks/${m[1]}` };
  // dig
  if (/^\/api\/dig$/.test(path)) return { kind: 'proxy', hubPath: '/api/data/digs' };
  if ((m = /^\/api\/dig\/(\d+)$/.exec(path))) return { kind: 'proxy', hubPath: `/api/data/digs/${m[1]}` };
  // dictionary
  if (/^\/api\/dictionary$/.test(path)) return { kind: 'proxy', hubPath: '/api/data/dictionary' };
  if ((m = /^\/api\/dictionary\/(\d+)$/.exec(path))) return { kind: 'proxy', hubPath: `/api/data/dictionary/${m[1]}` };
  // implementation-notes
  if (/^\/api\/implementation-notes$/.test(path)) return { kind: 'proxy', hubPath: '/api/data/implementation-notes' };
  if ((m = /^\/api\/implementation-notes\/(\d+)$/.exec(path))) {
    return { kind: 'proxy', hubPath: `/api/data/implementation-notes/${m[1]}` };
  }
  // work-locations
  if (/^\/api\/work-locations$/.test(path)) return { kind: 'proxy', hubPath: '/api/data/work-locations' };
  if ((m = /^\/api\/work-locations\/(\d+)$/.exec(path))) {
    return { kind: 'proxy', hubPath: `/api/data/work-locations/${m[1]}` };
  }
  // domain-catalog (ローカルは domain をキーにするが Hub は id。 list のみ確実に対応)
  if (/^\/api\/domains$/.test(path)) return { kind: 'proxy', hubPath: '/api/data/domain-catalog' };
  if ((m = /^\/api\/domains\/(\d+)$/.exec(path))) return { kind: 'proxy', hubPath: `/api/data/domain-catalog/${m[1]}` };
  // notes (uuid)
  if (/^\/api\/notes$/.test(path)) return { kind: 'proxy', hubPath: '/api/data/notes' };
  if ((m = /^\/api\/notes\/([0-9a-fA-F-]{8,})$/.exec(path))) {
    return { kind: 'proxy', hubPath: `/api/data/notes/${m[1]}` };
  }

  // ── 個人ログ系 = ローカル専用 (Hub には出さない、 [個人データ保管禁止]) ──
  if (/^\/api\/(diary|weekly|meals|locations|tracks|legatus|visits|trends|recommendations|activity|weather|transit|review|work-sessions|wifi)(\/|$)/.test(path)) {
    return { kind: 'local-only' };
  }

  // ── それ以外 (制御系 /api/multi/*・/api/setup/*、 インフラ系、 および
  //    Multi 対応型の未対応 sub-path) は local に素通し ──
  return { kind: 'passthrough' };
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

    // proxy: Hub の session token を取り出して /api/data/* に転送。
    const { servers } = readMultiServers(db);
    const server = findServerByUrl(servers, hubUrl);
    if (!server || !server.jwt) {
      return c.json({ error: 'hub_not_logged_in', mode: 'multi' }, 503);
    }

    const qs = new URL(c.req.url).search;
    const method = c.req.method;
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
