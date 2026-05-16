// Hub 側 PASETO v4 検証 (Cernere Phase 1 — Issue LUDIARS/Cernere#91)。
//
// Cernere は GET /.well-known/cernere-public-key で public key を公開する。
// 起動時 + 6h 毎に fetch して in-memory cache に持ち、 Bearer token の
// 検証を完全に local で行う (= Cernere 不到達でも検証は continue 可能)。
//
// 旧 HS256 (= 互換期間) の検証は index.js の verifyCernereJwt がそのまま残る。
// ここでは PASETO 検証のみを行う。

import { V4 } from 'paseto';

const CERNERE_BASE_URL = process.env.CERNERE_BASE_URL || 'http://localhost:8080';
const HUB_PUBLIC_URL = process.env.MEMORIA_HUB_PUBLIC_URL || '';
// 6 時間ごと refresh + 起動時 1 回。
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** keyCache: kid → { key (Buffer), fetched_at } */
const keyCache = new Map();
let refreshTimer = null;

export function getCachedKidList() {
  return [...keyCache.keys()];
}

export async function refreshPublicKeys() {
  try {
    const res = await fetch(`${CERNERE_BASE_URL}/.well-known/cernere-public-key`);
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    const body = await res.json();
    const keys = Array.isArray(body?.keys) ? body.keys : [];
    let added = 0;
    for (const k of keys) {
      if (!k?.kid || !k?.public_key) continue;
      const buf = Buffer.from(k.public_key, 'base64');
      if (buf.length !== 32) {
        console.warn(`[paseto] skipped kid=${k.kid} (public_key length=${buf.length}, expected 32)`);
        continue;
      }
      keyCache.set(k.kid, { key: buf, fetched_at: Date.now() });
      added++;
    }
    console.log(`[paseto] public key cache refreshed: ${added} key(s) total=${keyCache.size}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[paseto] refresh failed: ${msg} (cache size: ${keyCache.size})`);
  }
}

export function startPublicKeyRefreshLoop() {
  void refreshPublicKeys();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    void refreshPublicKeys();
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
}

/** PASETO v4 token を検証して claims を返す。 失敗時は null。
 *  検証項目:
 *    - PASETO header から kid 抽出、 cache lookup
 *    - V4 signature verify
 *    - aud === HUB_PUBLIC_URL (= 別 hub への replay 防止)
 *    - exp > now、 iat < now + 30sec (= clock skew)
 *    - kind === "user_for_project"
 */
export async function verifyPaseto(token) {
  if (typeof token !== 'string') return null;
  // v4.public.<base64...><.footer> 形式のみ受け付ける (= HS256 token は始まりが異なる)。
  if (!token.startsWith('v4.public.')) return null;

  // PASETO の footer (= JSON with kid) を覗き見るために decode のみ実行する。
  // paseto ライブラリは V4.verify に渡す前段で kid を取り出す API を提供していないので、
  // 全 cached key を順に試す方式で動かす (= key 数は 1-3 程度なので OK)。
  for (const [kid, entry] of keyCache.entries()) {
    try {
      const result = await V4.verify(token, entry.key, {
        complete: true,
        audience: HUB_PUBLIC_URL || undefined,
      });
      const payload = result?.payload ?? result;
      if (!payload || typeof payload !== 'object') continue;
      if (payload.kind !== 'user_for_project') {
        console.warn(`[paseto] rejected: kind=${payload.kind} kid=${kid}`);
        return null;
      }
      // audience が optional な場合 (= HUB_PUBLIC_URL 未設定で起動) はここで warn 出す。
      if (!HUB_PUBLIC_URL) {
        console.warn('[paseto] MEMORIA_HUB_PUBLIC_URL not set — aud check skipped');
      }
      // paseto v3 規約で iat/exp は ISO 8601 文字列。 Hub 内部表現は Unix epoch
      // (秒) に揃えるため変換する。 未パースは null。
      const expUnix = typeof payload.exp === 'string'
        ? Math.floor(new Date(payload.exp).getTime() / 1000)
        : typeof payload.exp === 'number' ? payload.exp : null;
      return {
        userId: typeof payload.sub === 'string' ? payload.sub : null,
        role: typeof payload.role === 'string' ? payload.role : 'general',
        displayName: typeof payload.displayName === 'string' ? payload.displayName : null,
        projectKey: typeof payload.projectKey === 'string' ? payload.projectKey : null,
        kid,
        jti: typeof payload.jti === 'string' ? payload.jti : null,
        exp: Number.isFinite(expUnix) ? expUnix : null,
      };
    } catch (e) {
      // kid 違い or invalid → 次の key を試す
      void e;
    }
  }
  return null;
}
