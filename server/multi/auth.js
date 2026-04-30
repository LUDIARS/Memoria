// Cernere SSO + JWT issuance for the multi server.
//
// Flow:
//   1. Browser/local-server hits  GET /api/auth/start  → 302 to Cernere with
//      Authorization Code + PKCE (state echoed in cookie).
//   2. Cernere bounces back to    GET /api/auth/callback?code=…
//      We swap the code for a Cernere access token, fetch /me, then mint a
//      Memoria-Hub JWT (HS256, 30 day TTL) and redirect back to the
//      `redirect_uri` the local server passed at step 1.
//   3. Subsequent API calls present the JWT in `Authorization: Bearer …`.
//
// Cernere endpoints are configured via env, so this can be pointed at the
// Cernere staging instance during development. Phase 7 wires the real
// production OAuth client.
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, createHash } from 'node:crypto';

const JWT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const COOKIE_PKCE = 'memoria_hub_pkce';
const COOKIE_REDIRECT = 'memoria_hub_redirect';

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function jwtSecret() {
  return new TextEncoder().encode(need('MEMORIA_JWT_SECRET'));
}

function cernereBase() {
  return need('MEMORIA_CERNERE_BASE').replace(/\/$/, '');
}

function cernereClientId() {
  return need('MEMORIA_CERNERE_CLIENT_ID');
}

function cernereClientSecret() {
  return need('MEMORIA_CERNERE_CLIENT_SECRET');
}

function selfBase() {
  return need('MEMORIA_HUB_BASE').replace(/\/$/, '');
}

// ── PKCE helpers ───────────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function makePkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ── routes ─────────────────────────────────────────────────────────────────

export function buildAuthorizeUrl({ challenge, state }) {
  const u = new URL(`${cernereBase()}/oauth/authorize`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cernereClientId());
  u.searchParams.set('redirect_uri', `${selfBase()}/api/auth/callback`);
  u.searchParams.set('scope', 'profile');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export async function exchangeCode({ code, verifier }) {
  const res = await fetch(`${cernereBase()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: cernereClientId(),
      client_secret: cernereClientSecret(),
      redirect_uri: `${selfBase()}/api/auth/callback`,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`cernere token exchange failed: ${res.status} ${body}`);
  }
  return res.json();
}

export async function fetchCernereUser(accessToken) {
  const res = await fetch(`${cernereBase()}/api/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`cernere /api/me failed: ${res.status}`);
  return res.json();
}

export async function mintHubJwt({ userId, displayName, role = 'user' }) {
  return new SignJWT({ sub: userId, name: displayName, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${JWT_TTL_SECONDS}s`)
    .setIssuer('memoria-hub')
    .sign(jwtSecret());
}

export async function verifyHubJwt(token) {
  const { payload } = await jwtVerify(token, jwtSecret(), { issuer: 'memoria-hub' });
  return {
    userId: payload.sub,
    displayName: payload.name,
    role: payload.role || 'user',
  };
}

// ── small cookie helpers (signed-state isn't needed because PKCE proves
//     possession of the verifier; the cookie is just a matching pair). ─────

export const cookieNames = {
  pkce: COOKIE_PKCE,
  redirect: COOKIE_REDIRECT,
};

export function setShortCookie(name, value, maxAgeSec = 600) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
