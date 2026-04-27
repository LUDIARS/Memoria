// Cernere integration bridge for Memoria.
//
// Two SDK adapters are wired here:
//
//   1. CernereServiceAdapter  — receives user_admission / user_revoke from
//      Cernere via WebSocket, issues HS256 service_token (using MEMORIA_JWT_SECRET).
//      The token is what Memoria's auth middleware verifies.
//
//   2. PeerAdapter            — accepts backend-to-backend invocations from
//      sibling LUDIARS services (Imperativus etc.) over WS, after a Cernere
//      challenge handshake. Used so that Imperativus can call into Memoria
//      without an extra HTTP hop.
//
// Both adapters are loaded LAZILY via dynamic import. The SDK lives in a
// private GitHub Packages registry; in environments without NPM_TOKEN
// (e.g. public CI) the package is silently absent and Memoria continues in
// stand-alone mode using its own HS256 verifier.
//
// Toggles via env vars (see .env.example for the full list):
//
//   CERNERE_WS_URL, CERNERE_SERVICE_CODE, CERNERE_SERVICE_SECRET   (admission)
//   CERNERE_PROJECT_ID, CERNERE_PROJECT_SECRET, CERNERE_BASE_URL    (peer)
//   MEMORIA_HOOK_TARGET                                             (events)

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

let SDK = null; // lazily resolved module namespace
let admission = null; // CernereServiceAdapter instance
let peer = null;      // PeerAdapter instance
let eventTarget = null;

async function loadSdk() {
  if (SDK !== null) return SDK;
  try {
    SDK = await import('@ludiars/cernere-service-adapter');
    return SDK;
  } catch (e) {
    SDK = false; // memoize "not installed"
    return null;
  }
}

export function isReady() {
  return { admission: !!admission, peer: !!peer, eventTarget };
}

export function getAdmissionAdapter() { return admission; }
export function getPeerAdapter() { return peer; }

/**
 * Start whatever Cernere bits we have configuration for. Safe to call when
 * env is incomplete: missing pieces just stay null.
 *
 * @param {object} ctx — runtime callbacks the adapters need.
 *   - upsertUser(user, organizationId, scopes) — store admitted user
 *   - revokeUser(userId)
 *   - peerHandlers — Record<string, (caller, payload) => any>
 *   - acceptList   — PeerAdapter `accept` config (per-service allow list)
 */
export async function startCernere(ctx) {
  const sdk = await loadSdk();
  if (!sdk) {
    console.log('[memoria-cernere] @ludiars/cernere-service-adapter not installed — Cernere integration disabled (Memoria runs in stand-alone JWT mode).');
    return { admission: false, peer: false };
  }

  const env = process.env;
  const jwtSecret = env.MEMORIA_JWT_SECRET ?? '';

  // ─── 1. Admission adapter (Cernere → Memoria) ──────────────────────────
  if (env.CERNERE_WS_URL && env.CERNERE_SERVICE_CODE && env.CERNERE_SERVICE_SECRET) {
    if (!jwtSecret) {
      console.warn('[memoria-cernere] CERNERE_* set but MEMORIA_JWT_SECRET is empty — admission adapter NOT started.');
    } else {
      const { CernereServiceAdapter } = sdk;
      admission = new CernereServiceAdapter({
        cernereWsUrl: env.CERNERE_WS_URL,
        serviceCode: env.CERNERE_SERVICE_CODE,
        serviceSecret: env.CERNERE_SERVICE_SECRET,
        jwtSecret,
        tokenExpiresIn: Number(env.MEMORIA_TOKEN_EXP_SEC) || 900,
      }, {
        onUserAdmission: async (user, orgId, scopes) => {
          try { await ctx.upsertUser(user, orgId, scopes); }
          catch (e) { console.error('[memoria-cernere] upsertUser failed:', e); }
        },
        onUserRevoke: async (uid) => {
          try { await ctx.revokeUser(uid); }
          catch (e) { console.error('[memoria-cernere] revokeUser failed:', e); }
        },
        onConnected: (sid) => console.log(`[memoria-cernere] admission connected (service_id=${sid})`),
        onDisconnected: () => console.log('[memoria-cernere] admission disconnected'),
        onError: (code, msg) => console.error(`[memoria-cernere] admission error ${code}: ${msg}`),
      });
      admission.connect();
    }
  } else {
    console.log('[memoria-cernere] admission adapter skipped (CERNERE_WS_URL / SERVICE_CODE / SERVICE_SECRET not all set)');
  }

  // ─── 2. Peer adapter (Imperativus → Memoria backend invokes) ───────────
  if (env.CERNERE_PROJECT_ID && env.CERNERE_PROJECT_SECRET && env.CERNERE_BASE_URL) {
    const { PeerAdapter } = sdk;
    peer = new PeerAdapter({
      projectId: env.CERNERE_PROJECT_ID,
      projectSecret: env.CERNERE_PROJECT_SECRET,
      cernereBaseUrl: env.CERNERE_BASE_URL,
      saListenHost: env.MEMORIA_SA_HOST ?? '0.0.0.0',
      saListenPort: Number(env.MEMORIA_SA_PORT) || 0,
      saPublicBaseUrl: env.MEMORIA_SA_PUBLIC_URL ?? 'ws://127.0.0.1:{port}',
      accept: ctx.acceptList ?? {
        // Default: only Imperativus may call Memoria, and only the published
        // commands. Tighten via env in production.
        imperativus: [
          'memoria.search',
          'memoria.save_url',
          'memoria.save_html',
          'memoria.list_categories',
          'memoria.recent_bookmarks',
          'memoria.get_bookmark',
          'memoria.dig',
          'memoria.unsaved_visits',
          'ping',
        ],
      },
    });
    // Always-on ping for connection diagnostics.
    peer.handle('ping', async (caller, payload) => ({
      ok: true, from: caller.projectKey, echo: payload, ts: Date.now(),
    }));
    for (const [cmd, fn] of Object.entries(ctx.peerHandlers ?? {})) {
      peer.handle(cmd, fn);
    }
    await peer.start();
    console.log(`[memoria-cernere] peer adapter started on port ${peer.boundListenPort}`);
  } else {
    console.log('[memoria-cernere] peer adapter skipped (CERNERE_PROJECT_ID / PROJECT_SECRET / BASE_URL not all set)');
  }

  eventTarget = env.MEMORIA_HOOK_TARGET || null;
  if (peer && eventTarget) {
    console.log(`[memoria-cernere] events will be relayed to "${eventTarget}" via peer adapter`);
  }

  return { admission: !!admission, peer: !!peer };
}

export async function stopCernere() {
  try { if (peer) await peer.stop(); } catch {}
  try { if (admission) admission.disconnect?.(); } catch {}
  peer = null;
  admission = null;
}

/**
 * Emit a Memoria-side event to the configured peer (typically Imperativus).
 * Per-user routing is the receiver's responsibility — Memoria just publishes
 * `{event, user_id, payload}` and trusts Imperativus to dispatch.
 *
 * If the peer adapter isn't running, or no target is configured, this is a
 * silent no-op (best-effort).
 */
export async function emitEvent(eventName, { userId = null, payload = {} } = {}) {
  if (!peer || !eventTarget) return { delivered: false, reason: 'peer-disabled' };
  try {
    const r = await peer.invoke(eventTarget, 'events.emit', {
      source: 'memoria',
      event: eventName,
      user_id: userId,
      payload,
      ts: Date.now(),
    });
    return { delivered: true, target: eventTarget, response: r };
  } catch (e) {
    console.warn(`[memoria-cernere] event "${eventName}" → ${eventTarget} failed:`, e?.message ?? e);
    return { delivered: false, reason: e?.message ?? String(e) };
  }
}

export function isAdmissionRevoked(userId) {
  if (!admission) return false;
  try { return admission.isRevoked?.(userId) === true; }
  catch { return false; }
}
