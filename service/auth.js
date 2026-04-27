// Lightweight Bearer/JWT auth middleware.
//
// Memoria has two run modes:
//
//   MEMORIA_MODE=local   (default) — single-user, no auth, all endpoints open.
//   MEMORIA_MODE=online            — multi-user. GET endpoints are public; any
//                                    mutation requires a Bearer JWT signed with
//                                    MEMORIA_JWT_SECRET (HS256). The token's
//                                    `sub` claim is used as the user_id.
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
 * Fail-open auth middleware.
 *
 *   - LOCAL  : userId = null, mode = 'local'
 *   - ONLINE : if a valid Bearer JWT is present → userId = sub.
 *              Missing or invalid token → userId = null (request continues).
 *
 * Per-route mutation handlers should call `requireAuth(c)` and bail out on a
 * 401 from this helper. Read endpoints stay public in online mode so the
 * Memoria UI can serve as a viewer for unauthenticated visitors.
 */
export function authMiddleware({ mode, secret }) {
  return async (c, next) => {
    c.set('mode', mode);
    if (mode !== MODES.ONLINE) {
      c.set('userId', null);
      return next();
    }
    const auth = c.req.header('Authorization') || c.req.header('authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m || !secret) {
      c.set('userId', null);
      return next();
    }
    try {
      const payload = verifyJwt(m[1], secret);
      c.set('userId', payload.sub ? String(payload.sub) : null);
    } catch {
      c.set('userId', null);
    }
    return next();
  };
}

/**
 * Per-route auth gate. Use inside any handler that performs a mutation.
 * Returns `null` when the request is allowed to proceed, or a 401 Response
 * the caller should `return` directly.
 *
 * In LOCAL mode this is always a no-op (no auth concept). In ONLINE mode
 * the request must already carry a valid Bearer JWT (verified by middleware).
 */
export function requireAuth(c) {
  if ((c.get('mode') ?? 'local') !== MODES.ONLINE) return null;
  if (c.get('userId')) return null;
  return c.json({ error: 'unauthorized: sign-in required for write actions' }, 401);
}
