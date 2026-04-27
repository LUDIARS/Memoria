// Lightweight Bearer/JWT auth middleware.
//
// Memoria has two run modes:
//
//   MEMORIA_MODE=local   (default) — single-user, no auth, all endpoints open
//   MEMORIA_MODE=online            — multi-user, every API call must carry
//                                    a Bearer JWT signed with MEMORIA_JWT_SECRET
//                                    (HS256). The token's `sub` claim is used
//                                    as the user_id.
//
// In production this secret should be the SAME secret used by the Cernere
// service-adapter when issuing service-scoped JWTs (see Cernere
// `@ludiars/cernere-service-adapter`). Memoria itself does not call Cernere
// directly — it only verifies the resulting JWT.
//
// For local development, a token can be minted with `node scripts/issue-token.mjs`.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const MODES = { LOCAL: 'local', ONLINE: 'online' };

export function readMode() {
  const m = (process.env.MEMORIA_MODE ?? 'local').toLowerCase();
  return m === 'online' ? MODES.ONLINE : MODES.LOCAL;
}

/** Sign a payload with HS256. Used by the dev token issuer; production tokens
 *  come from the Cernere admission flow. */
export function signJwt(payload, secret, { expSeconds = 60 * 60 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + expSeconds, ...payload };
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = (o) => base64UrlEncode(Buffer.from(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(body)}`;
  const sig = createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

/** Verify HS256 JWT. Throws on any failure. Returns the decoded payload. */
export function verifyJwt(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [hB, pB, sB] = parts;
  const expectedSig = createHmac('sha256', secret).update(`${hB}.${pB}`).digest();
  const givenSig = base64UrlDecode(sB);
  if (expectedSig.length !== givenSig.length || !timingSafeEqual(expectedSig, givenSig)) {
    throw new Error('bad signature');
  }
  let payload;
  try { payload = JSON.parse(base64UrlDecode(pB).toString('utf8')); }
  catch { throw new Error('bad payload'); }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('token expired');
  }
  return payload;
}

function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * Hono middleware. In ONLINE mode, requires a valid Bearer token; sets
 * `c.set("userId", ...)` for downstream handlers. In LOCAL mode this is a
 * no-op and userId stays null.
 */
export function authMiddleware({ mode, secret }) {
  return async (c, next) => {
    if (mode !== MODES.ONLINE) {
      c.set('userId', null);
      c.set('mode', mode);
      return next();
    }
    if (!secret) {
      return c.json({ error: 'server misconfigured: MEMORIA_JWT_SECRET not set' }, 500);
    }
    const auth = c.req.header('Authorization') || c.req.header('authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      return c.json({ error: 'unauthorized: bearer token required' }, 401);
    }
    let payload;
    try { payload = verifyJwt(m[1], secret); }
    catch (e) { return c.json({ error: `unauthorized: ${e.message}` }, 401); }
    if (!payload.sub) {
      return c.json({ error: 'unauthorized: token missing sub' }, 401);
    }
    c.set('userId', String(payload.sub));
    c.set('mode', mode);
    return next();
  };
}
