// env-bootstrap — Hub のアプリ設定値を Infisical から取得する。
//
// Hub は自分の Infisical project を持ち、 自分が属する Cernere
// (CERNERE_BASE_URL 等) をそこから知る。 machine identity (INFISICAL_*) は
// Infisical に入れられない (chicken-and-egg) ので、 以下のどれかで渡す:
//
//   (A) Excubitor inject / host shell env
//   (B) Hub の app_settings (= GET / の Infisical 設定フォーム入力)
//       → bootstrap.js が起動時に Postgres から読んで process.env に載せる
//
// ローカル Memoria の server/lib/env-bootstrap.ts と同じ設計の JS 版。

/** Infisical から取れていてほしい設定キー (揃わなければ起動ログで警告)。 */
const WANTED_KEYS = [
  'CERNERE_BASE_URL', // Cernere の base URL — auth login 代理 + PASETO 公開鍵 fetch
];

/** app_settings のキー名 ↔ INFISICAL_* env 名 の対応。 */
export const INFISICAL_SETTING_KEYS = {
  'infisical.site_url': 'INFISICAL_SITE_URL',
  'infisical.project_id': 'INFISICAL_PROJECT_ID',
  'infisical.environment': 'INFISICAL_ENVIRONMENT',
  'infisical.client_id': 'INFISICAL_CLIENT_ID',
  'infisical.client_secret': 'INFISICAL_CLIENT_SECRET',
};

/** process.env から machine identity を組み立て (足りなければ null)。 */
function credsFromEnv() {
  const siteUrl = process.env.INFISICAL_SITE_URL?.replace(/\/$/, '');
  const projectId = process.env.INFISICAL_PROJECT_ID;
  const environment = process.env.INFISICAL_ENVIRONMENT ?? 'dev';
  const clientId = process.env.INFISICAL_CLIENT_ID;
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
  if (!siteUrl || !projectId || !clientId || !clientSecret) return null;
  return { siteUrl, projectId, environment, clientId, clientSecret };
}

/** 指定 creds で Infisical にログインして全 secret を取得。 */
async function fetchSecrets(creds) {
  const siteUrl = creds.siteUrl.replace(/\/$/, '');
  const loginRes = await fetch(`${siteUrl}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: creds.clientId, clientSecret: creds.clientSecret }),
  });
  if (!loginRes.ok) throw new Error(`Infisical login failed: ${loginRes.status}`);
  const { accessToken } = await loginRes.json();

  const params = new URLSearchParams({
    workspaceId: creds.projectId,
    environment: creds.environment,
    secretPath: '/',
  });
  const secretsRes = await fetch(`${siteUrl}/api/v3/secrets/raw?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!secretsRes.ok) throw new Error(`Infisical secrets fetch failed: ${secretsRes.status}`);
  const { secrets } = await secretsRes.json();
  return secrets;
}

/** secrets を process.env に注入 (既存値は上書きしない = host env / Excubitor 優先)。 */
function injectSecrets(secrets) {
  let injected = 0;
  for (const s of secrets) {
    if (!process.env[s.secretKey]) {
      process.env[s.secretKey] = s.secretValue;
      injected++;
    }
  }
  return injected;
}

/**
 * 起動時に 1 回呼ぶ。 process.env の INFISICAL_* creds で Infisical から fetch。
 * creds 不足 / Infisical 到達失敗 どちらも throw せず result で返す
 * (= GET / のセットアップフォームで後から入力させるため、 ここでは落とさない)。
 */
export async function ensureEnv() {
  const creds = credsFromEnv();
  if (!creds) return { ok: false, injected: 0, reason: 'no_creds' };
  try {
    const secrets = await fetchSecrets(creds);
    const injected = injectSecrets(secrets);
    console.log(`[env-bootstrap] injected ${injected} secrets from Infisical`);
    return { ok: true, injected };
  } catch (err) {
    console.warn(`[env-bootstrap] ${err.message} — Infisical をスキップして起動`);
    return { ok: false, injected: 0, reason: 'infisical_error', message: err.message };
  }
}

/**
 * 設定フォームから渡された creds で Infisical 接続を試す。
 * 成功したら process.env に creds + 全 secret を inject。 失敗時は throw。
 */
export async function applyInfisicalCreds(creds) {
  const secrets = await fetchSecrets(creds);
  process.env.INFISICAL_SITE_URL = creds.siteUrl;
  process.env.INFISICAL_PROJECT_ID = creds.projectId;
  process.env.INFISICAL_ENVIRONMENT = creds.environment;
  process.env.INFISICAL_CLIENT_ID = creds.clientId;
  process.env.INFISICAL_CLIENT_SECRET = creds.clientSecret;
  const injected = injectSecrets(secrets);
  console.log(`[env-bootstrap] applyInfisicalCreds: injected ${injected} secrets`);
  return { injected };
}

/** machine identity が process.env に揃っているか。 */
export function hasInfisicalCreds() {
  return credsFromEnv() !== null;
}

/** 未設定の WANTED_KEYS を返す (起動ログ用)。 */
export function missingWantedKeys() {
  return WANTED_KEYS.filter((k) => !process.env[k]);
}
