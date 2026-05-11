// Memoria Hub — Cernere 連携ブリッジ (rev3、 service-adapter 準拠)
//
// 設計思想:
//   ・Cernere は /auth しか公開しない (REST + WS)
//   ・サービス側は @ludiars/cernere-service-adapter で /ws/service に常時接続し、
//     Cernere が「このユーザを memoria-hub に admit する」 と push したときに
//     onUserAdmission を受け取る → 受け入れ後、 adapter が短命 service_token
//     (HS256 JWT) を mint して admission_response で Cernere に返す。
//   ・user / SPA は service_token を Cernere 側経由で受け取り、 以降
//     Authorization: Bearer <service_token> で Hub の /api/shared/* を叩く。
//   ・Hub は createServiceAuthMiddleware で token を **ローカル検証** する
//     (Cernere に毎リクエスト問い合わせない)。
//
// 旧 OAuth Authorization Code + PKCE / password proxy 経路は撤去 (Cernere の
// 設計思想に反するため)。

import { CernereServiceAdapter } from '@ludiars/cernere-service-adapter';
import { WebSocket } from 'ws';

let adapter = null;

export function getAdapter() {
  return adapter;
}

/**
 * Cernere /ws/service に常時接続する。 認証情報が揃っていなければ no-op
 * (= Hub は単独で boot 可能、 admission を受け付けない状態で動作)。
 */
export function initCernereBridge() {
  const cernereWsUrl = process.env.CERNERE_WS_URL;
  const serviceCode = process.env.CERNERE_SERVICE_CODE || 'memoria-hub';
  const serviceSecret = process.env.CERNERE_SERVICE_SECRET;
  const jwtSecret = process.env.SERVICE_JWT_SECRET;

  if (!cernereWsUrl || !serviceSecret || !jwtSecret) {
    console.warn('[cernere-bridge] CERNERE_WS_URL / CERNERE_SERVICE_SECRET / SERVICE_JWT_SECRET が未設定 — bridge skip');
    return null;
  }

  adapter = new CernereServiceAdapter(
    {
      cernereWsUrl,
      serviceCode,
      serviceSecret,
      jwtSecret,
    },
    {
      // user_admission: Cernere が「このユーザを memoria-hub に受け入れる」
      // と push してきたタイミング。 Memoria-Hub は個人データを保管しないため
      // (Cernere が単一情報源)、 ローカル DB への upsert は最小限 (= ID 程度)
      // で済む。 現状は何もしないでよい (各 /api/shared/* row に owner_user_id
      // が直接書かれるので、 user テーブルが存在しない設計でも動く)。
      onUserAdmission: async (user, organizationId, scopes) => {
        console.log(`[cernere-bridge] user admitted: ${user.id} (${user.role}) org=${organizationId ?? '-'} scopes=${(scopes ?? []).join(',') || '-'}`);
        // adapter が自動で service_token を mint + admission_response を返す
      },
      onUserRevoke: async (userId) => {
        console.log(`[cernere-bridge] user revoked: ${userId}`);
        // adapter 内部の revokedUsers Set に追加されるので、
        // middleware が次の request で 401 を返すようになる。
      },
      onConnected: (serviceId) => {
        console.log(`[cernere-bridge] connected to Cernere (service_id=${serviceId})`);
      },
      onDisconnected: () => {
        console.warn('[cernere-bridge] disconnected from Cernere — auto reconnect (5s)');
      },
      onError: (code, message) => {
        console.error(`[cernere-bridge] error code=${code} message=${message}`);
      },
    },
    WebSocket,
  );
  adapter.connect();
  return adapter;
}
