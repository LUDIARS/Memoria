// Memoria Hub — データベースハブ entry point (二層設計)
//
// Hono on Node, Postgres-backed。 UI は 2 ページ (GET / の Infisical 設定 /
// ログイン) のみ、 それ以外は JSON。
//
// Endpoints:
//   GET    /healthz
//   GET    /                          Infisical 設定 or ログイン UI (HTML)
//   GET    /api/setup/infisical/status
//   POST   /api/setup/infisical
//   POST   /api/auth/login             Cernere 代理ログイン → session token
//   GET    /api/auth/me                (session)
//   POST   /api/auth/logout            (session)
//   GET    /api/data/:type             7 型の list      (session)
//   GET    /api/data/:type/:id         1 件取得          (session)
//   POST   /api/data/:type             作成             (session)
//   PATCH  /api/data/:type/:id         更新             (session)
//   DELETE /api/data/:type/:id         削除             (session)
//
// 認証: POST /api/auth/login が Cernere に代理ログイン → project-token (PASETO
// v4) を session token として返す。 以降クライアントは Authorization: Bearer
// <session token> で /api/data/* を叩き、 authMiddleware が **ローカルで** 検証。
//
// 旧 /api/shared/* (share-relay 方式) は Phase 6 で撤去。
//
// CORS is restricted to MEMORIA_HUB_ALLOWED_ORIGINS (comma-separated).

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { createHmac } from 'node:crypto';
import { initCernereBridge, getAdapter } from './cernere-bridge.js';
import {
  applyInfisicalCreds, hasInfisicalCreds, missingWantedKeys,
} from './env-bootstrap.js';
import { writeCreds } from './creds-store.js';
import { cernereLogin, cernereProjectToken } from './cernere-login.js';
import {
  DATA_TYPES, listData, getData, createData, updateData, deleteData,
} from './data.js';

const PORT = Number(process.env.MEMORIA_HUB_PORT ?? 5280);
const ALLOWED = (process.env.MEMORIA_HUB_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const app = new Hono();

if (ALLOWED.length > 0) {
  app.use('/api/*', cors({ origin: ALLOWED, credentials: true }));
} else {
  // No allow-list configured — refuse cross-origin entirely so misconfig
  // doesn't accidentally open the API.
  app.use('/api/*', cors({ origin: () => '', credentials: false }));
}

app.get('/healthz', (c) => c.text('ok'));

// ── ルート (GET /) — Hub が持つ唯一の web UI ───────────────────────────────
//
// Hub は「データベースハブ」 であり UI は 2 画面しか持たない:
//   1. Infisical 未設定 → Infisical machine identity の設定フォーム
//   2. 設定済み        → ログイン画面 (Phase 2 で実装。 当面は稼働状況を表示)
// それ以外は全部 JSON を返す。

const SETUP_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memoria Hub — Infisical 設定</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 460px; margin: 6vh auto; padding: 0 20px; line-height: 1.6; }
  h1 { font-size: 1.3rem; }
  p.note { color: #888; font-size: .88rem; }
  label { display: block; margin-top: 14px; font-size: .85rem; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; margin-top: 4px; padding: 10px 12px;
          border: 1px solid #bbb; border-radius: 8px; font-size: 14px; }
  button { margin-top: 20px; width: 100%; padding: 11px; border: 0; border-radius: 8px;
           background: #4a6cf7; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .msg { margin-top: 14px; font-size: .88rem; }
  .msg.err { color: #d33; }
  .msg.ok { color: #2a8; }
</style></head><body>
<h1>Memoria Hub — Infisical 設定</h1>
<p class="note">この Hub の Infisical machine identity を登録します。 Hub は自分の
Infisical project から接続先 Cernere 等の設定を取得します。 値は Hub の DB に
保存され、 client_secret は二度と画面に表示されません。</p>
<form id="f">
  <label>Infisical Site URL
    <input name="siteUrl" placeholder="https://infisical.vtn-game.com" required></label>
  <label>Project ID
    <input name="projectId" placeholder="xxxxxxxx-xxxx-..." required></label>
  <label>Environment
    <input name="environment" value="prod" required></label>
  <label>Client ID
    <input name="clientId" required></label>
  <label>Client Secret
    <input name="clientSecret" type="password" required></label>
  <button type="submit">接続して保存</button>
  <div id="msg" class="msg"></div>
</form>
<script>
const f = document.getElementById('f'), msg = document.getElementById('msg');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = f.querySelector('button');
  btn.disabled = true; msg.className = 'msg'; msg.textContent = '接続中…';
  const body = Object.fromEntries(new FormData(f).entries());
  try {
    const res = await fetch('/api/setup/infisical', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { msg.className = 'msg err'; msg.textContent = j.error || ('HTTP ' + res.status); btn.disabled = false; return; }
    msg.className = 'msg ok';
    msg.textContent = '保存しました (' + j.injected + ' 件の secret を取得)。 Hub を再起動すると完全に反映されます。';
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = String(err); btn.disabled = false;
  }
});
</script>
</body></html>`;

const LOGIN_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memoria Hub — ログイン</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 380px; margin: 9vh auto; padding: 0 20px; line-height: 1.6; }
  h1 { font-size: 1.3rem; }
  p.note { color: #888; font-size: .85rem; }
  label { display: block; margin-top: 14px; font-size: .85rem; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; margin-top: 4px; padding: 10px 12px;
          border: 1px solid #bbb; border-radius: 8px; font-size: 14px; }
  button { margin-top: 20px; width: 100%; padding: 11px; border: 0; border-radius: 8px;
           background: #4a6cf7; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .msg { margin-top: 14px; font-size: .88rem; }
  .msg.err { color: #d33; }
  .msg.ok { color: #2a8; }
</style></head><body>
<h1>Memoria Hub</h1>
<p class="note">この Hub にログインします。 認証は Hub が内部で Cernere に
代理ログインします。 通常はローカル Memoria の Multi スイッチャから繋ぐので、
この画面は動作確認用です。</p>
<form id="f">
  <label>メールアドレス <input name="email" type="email" required></label>
  <label>パスワード <input name="password" type="password" required></label>
  <button type="submit">ログイン</button>
  <div id="msg" class="msg"></div>
</form>
<script>
const f = document.getElementById('f'), msg = document.getElementById('msg');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = f.querySelector('button');
  btn.disabled = true; msg.className = 'msg'; msg.textContent = 'ログイン中…';
  const body = Object.fromEntries(new FormData(f).entries());
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { msg.className = 'msg err'; msg.textContent = j.error || ('HTTP ' + res.status); btn.disabled = false; return; }
    msg.className = 'msg ok';
    msg.textContent = 'ログイン成功: ' + (j.user && j.user.displayName || '(unknown)');
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = String(err); btn.disabled = false;
  }
});
</script>
</body></html>`;

app.get('/', (c) => {
  if (!hasInfisicalCreds()) return c.html(SETUP_PAGE);
  return c.html(LOGIN_PAGE);
});

// ── /api/setup/infisical — Infisical machine identity の設定 ───────────────

app.get('/api/setup/infisical/status', (c) => {
  return c.json({
    configured: hasInfisicalCreds(),
    siteUrl: process.env.INFISICAL_SITE_URL || null,
    projectId: process.env.INFISICAL_PROJECT_ID || null,
    environment: process.env.INFISICAL_ENVIRONMENT || null,
    missingKeys: missingWantedKeys(),
  });
});

app.post('/api/setup/infisical', async (c) => {
  const body = await c.req.json().catch(() => null);
  const siteUrl = body?.siteUrl?.trim();
  const projectId = body?.projectId?.trim();
  const environment = body?.environment?.trim() || 'prod';
  const clientId = body?.clientId?.trim();
  const clientSecret = body?.clientSecret?.trim();
  if (!siteUrl || !projectId || !clientId || !clientSecret) {
    return c.json({ error: 'siteUrl / projectId / clientId / clientSecret は必須です' }, 400);
  }
  const creds = { siteUrl, projectId, environment, clientId, clientSecret };
  let result;
  try {
    // まず接続検証 + process.env に inject (= 失敗したら保存しない)。
    result = await applyInfisicalCreds(creds);
  } catch (err) {
    return c.json({ error: `Infisical 接続失敗: ${err.message}` }, 502);
  }
  try {
    // creds はファイルに保存 (Postgres は不可 — MEMORIA_PG_URL 自体が
    // Infisical 経由で来るため循環依存になる)。
    writeCreds(creds);
  } catch (err) {
    return c.json({ error: `creds ファイル保存失敗: ${err.message}` }, 500);
  }
  return c.json({ ok: true, injected: result.injected });
});

// ── /api/auth/* — Cernere 代理ログイン + session ───────────────────────────
//
// session token はステートレス: Cernere の project-token (PASETO v4) か、
// 取得失敗時は Cernere accessToken (HS256) をそのまま session token とする。
// どちらも authMiddleware が検証できる。 サーバ側 session ストアは持たない。

function hubPublicUrl(c) {
  if (process.env.MEMORIA_HUB_PUBLIC_URL) {
    return process.env.MEMORIA_HUB_PUBLIC_URL.replace(/\/$/, '');
  }
  const proto = c.req.header('x-forwarded-proto') || 'http';
  const host = c.req.header('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = body?.email?.trim();
  const password = body?.password;
  if (!email || !password) return c.json({ error: 'email + password は必須です' }, 400);
  if (!hasInfisicalCreds()) {
    return c.json({ error: 'Hub が未設定です (Infisical)' }, 503);
  }

  let login;
  try {
    login = await cernereLogin(email, password);
  } catch (err) {
    return c.json({ error: err.message, detail: err.detail }, err.status || 502);
  }

  const accessToken = login.accessToken;
  const u = login.user || {};
  let sessionToken = accessToken;
  try {
    const pt = await cernereProjectToken(accessToken, hubPublicUrl(c));
    if (pt?.accessToken) sessionToken = pt.accessToken;
  } catch (err) {
    console.warn(`[auth] project-token 取得失敗、 accessToken を session token に転用: ${err.message}`);
  }

  return c.json({
    sessionToken,
    user: {
      userId: u.id || u.userId || null,
      displayName: u.displayName || u.name || u.email || email,
      role: u.role || 'general',
    },
  });
});

// /api/auth/me, /api/auth/logout は authMiddleware に依存するため、
// その定義の後 (= /api/me の隣) で登録する。

// ── Cernere bridge: /ws/service に常時接続 (admission push、 future API) ──
//
// NOTE (2026-05-09): 現在の Cernere には /ws/service エンドポイントが未実装。
// 当面は initCernereBridge() は no-op に近い (auto-reconnect ループ) になる。
// 将来 Cernere 側で /ws/service が実装されると、 onUserAdmission が呼ばれて
// service_token mint flow が成立する。

initCernereBridge();
const adapter = getAdapter();
void adapter; // 将来 isRevoked check 等に使う想定

// 当面の認証: Cernere が発行した accessToken (HS256 JWT、 claim: sub/role/iat/exp)
// を **ローカルで** HMAC 検証する。
//
// CERNERE_JWT_SECRET = Cernere の .env の JWT_SECRET と一致させること。
// id-cache パッケージは payload.userId を期待するが Cernere は RFC 7519 標準の
// `sub` を使うため、 ここでは小さい自前 middleware で sub を読む。

const CERNERE_JWT_SECRET = process.env.CERNERE_JWT_SECRET ?? '';
const IS_DEV = process.env.NODE_ENV !== 'production';

// PASETO v4 (Phase 1 / Cernere Issue #91)。 起動時 + 6h 毎に Cernere の
// /.well-known/cernere-public-key を fetch して in-memory cache に持つ。
import { verifyPaseto, startPublicKeyRefreshLoop, getCachedKidList } from './paseto-verifier.js';
startPublicKeyRefreshLoop();
console.log(`[hub] PASETO public key refresh loop started (cernere: ${process.env.CERNERE_BASE_URL || 'http://localhost:8080'})`);

function verifyCernereJwt(token) {
  if (!CERNERE_JWT_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = createHmac('sha256', CERNERE_JWT_SECRET)
    .update(`${h}.${p}`).digest('base64url');
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return {
      userId: typeof payload.sub === 'string' ? payload.sub : null,
      role: typeof payload.role === 'string' ? payload.role : 'general',
    };
  } catch { return null; }
}

const authMiddleware = async (c, next) => {
  const auth = c.req.header('authorization') ?? c.req.header('Authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const raw = m[1];
    // PASETO v4 (新、 Cernere の signProjectToken が発行) を優先検証
    if (raw.startsWith('v4.public.')) {
      const p = await verifyPaseto(raw);
      if (p?.userId) {
        c.set('userId', p.userId);
        c.set('userRole', p.role);
        if (p.displayName) c.set('userName', p.displayName);
        c.set('tokenAlg', 'EdDSA');
        return next();
      }
      // PASETO 形式だが検証失敗 → fallback には流さず即拒否 (= forge 防止)
      console.warn(`[auth] PASETO token verify failed (cached kids: ${getCachedKidList().join(',') || '(empty)'})`);
      return c.json({ error: 'unauthorized', detail: 'paseto verify failed' }, 401);
    }
    // 旧 HS256 (= 互換期間中の legacy client)
    const v = verifyCernereJwt(raw);
    if (v?.userId) {
      c.set('userId', v.userId);
      c.set('userRole', v.role);
      c.set('tokenAlg', 'HS256');
      console.warn(`[auth] deprecated HS256 token used (user=${v.userId.slice(0, 8)}) — migrate to PASETO`);
      return next();
    }
  }
  if (IS_DEV) {
    const devUserId = c.req.header('x-user-id') ?? c.req.header('X-User-Id');
    if (devUserId) {
      c.set('userId', devUserId);
      c.set('userRole', c.req.header('x-user-role') ?? c.req.header('X-User-Role') ?? 'general');
      return next();
    }
  }
  return c.json({ error: 'unauthorized' }, 401);
};

// authedUser は middleware 通過後に c.get('userId') 等から組み立てる。
// Cernere は JWT に displayName を入れていない (sub/role/iat/exp のみ) ので、
// 当面は userId の先頭 8 文字を fallback 表示名にする。 後で /api/auth/me 経由
// で取りに行くか、 push admission 時に upsert した DB から引く方針へ。
function authedUser(c) {
  const userId = c.get('userId');
  if (!userId || userId === 'anonymous') return null;
  return {
    userId,
    displayName: c.get('userName') ?? `user-${userId.slice(0, 8)}`,
    role: c.get('userRole') ?? 'general',
  };
}

app.get('/api/me', authMiddleware, (c) => {
  const u = authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  return c.json(u);
});

// /api/auth/me — /api/me と同じ (二層設計の新 path 名)。
app.get('/api/auth/me', authMiddleware, (c) => {
  const u = authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  return c.json(u);
});

// /api/auth/logout — session token はステートレス (PASETO/JWT)。 サーバ側破棄は
// 無く、 クライアントが token を捨てることでログアウトが成立する。
app.post('/api/auth/logout', authMiddleware, (c) => c.json({ ok: true }));

// ── /api/data/* — Multi 対応 7 型の汎用 JSON CRUD (二層設計の本線) ─────────
//
// GET も含め全て session 必須 (Multi モードは Hub にログインした状態でのみ
// 動く前提)。 旧 /api/shared/* は Phase 6 で撤去済。

const DATA_TYPE_SET = new Set(DATA_TYPES);

function dataActor(c) {
  const u = authedUser(c);
  if (!u) return null;
  return { userId: u.userId, displayName: u.displayName, role: u.role };
}

app.get('/api/data/:type', authMiddleware, async (c) => {
  const type = c.req.param('type');
  if (!DATA_TYPE_SET.has(type)) return c.json({ error: 'unknown_type' }, 404);
  try {
    const items = await listData(type, {
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
      q: c.req.query('q') || c.req.query('search') || null,
    });
    return c.json({ items });
  } catch (err) {
    return c.json({ error: err.message }, err.status || 500);
  }
});

app.get('/api/data/:type/:id', authMiddleware, async (c) => {
  const type = c.req.param('type');
  if (!DATA_TYPE_SET.has(type)) return c.json({ error: 'unknown_type' }, 404);
  try {
    const row = await getData(type, c.req.param('id'));
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json(row);
  } catch (err) {
    return c.json({ error: err.message }, err.status || 500);
  }
});

app.post('/api/data/:type', authMiddleware, async (c) => {
  const type = c.req.param('type');
  if (!DATA_TYPE_SET.has(type)) return c.json({ error: 'unknown_type' }, 404);
  const actor = dataActor(c);
  if (!actor) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400);
  try {
    const row = await createData(type, body, {
      userId: actor.userId,
      displayName: actor.displayName,
      sharedOrigin: c.req.header('x-memoria-origin') || null,
    });
    return c.json(row, 201);
  } catch (err) {
    return c.json({ error: err.message }, err.status || 500);
  }
});

app.patch('/api/data/:type/:id', authMiddleware, async (c) => {
  const type = c.req.param('type');
  if (!DATA_TYPE_SET.has(type)) return c.json({ error: 'unknown_type' }, 404);
  const actor = dataActor(c);
  if (!actor) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400);
  try {
    const r = await updateData(type, c.req.param('id'), body, actor);
    if (!r.ok) return c.json({ error: r.error }, r.error === 'not_found' ? 404 : 403);
    return c.json(r.row);
  } catch (err) {
    return c.json({ error: err.message }, err.status || 500);
  }
});

app.delete('/api/data/:type/:id', authMiddleware, async (c) => {
  const type = c.req.param('type');
  if (!DATA_TYPE_SET.has(type)) return c.json({ error: 'unknown_type' }, 404);
  const actor = dataActor(c);
  if (!actor) return c.json({ error: 'unauthorized' }, 401);
  try {
    const r = await deleteData(type, c.req.param('id'), actor);
    if (!r.ok) return c.json({ error: r.error }, r.error === 'not_found' ? 404 : 403);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err.message }, err.status || 500);
  }
});

// ── boot ───────────────────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Memoria Hub (multi) listening on http://localhost:${info.port}`);
  console.log(`  cernere ws: ${process.env.CERNERE_WS_URL || '(unset)'}`);
  console.log(`  service_code: ${process.env.CERNERE_SERVICE_CODE || 'memoria-hub'}`);
  console.log(`  cernere bridge: ${adapter ? 'connecting' : 'skip (creds missing)'}`);
  console.log(`  pg: ${process.env.MEMORIA_PG_URL ? '(configured)' : '(unset)'}`);
});
