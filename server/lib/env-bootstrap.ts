/**
 * env-bootstrap — `.env` ファイル無しで Memoria server を起動するための env 注入。
 *
 * アプリ設定値 (CERNERE_BASE_URL / MEMORIA_PLACES_API_KEY 等) は Infisical に置く。
 * Infisical に到達するための machine identity 認証情報 (INFISICAL_*) だけは
 * Infisical に入れられない (chicken-and-egg) ので、 以下のどれかで渡す:
 *
 *   (A) Excubitor 経由: catalog.infisical.inject=true で 親が child env に注入
 *   (B) app_settings:   専用セットアップ画面で入力 → SQLite app_settings に保存
 *                       (bootstrap.ts が起動時に読んで process.env に載せる)
 *   (C) host shell env: 手動で INFISICAL_* を export してから起動
 *
 * Cernere/Actio/Imperativus/Nuntius と同じパターン (LUDIARS/Cernere#79)。
 */

/** Infisical から取れていてほしい設定キー。 揃わなければ起動ログで警告。 */
const WANTED_KEYS: readonly string[] = [
  'CERNERE_BASE_URL',          // Memoria Hub の認証で叩く Cernere の base URL
  'MEMORIA_PLACES_API_KEY',    // server-side Google key (Routes/Places/Geocoding、 referer 制限なし)
];

/** machine identity の 5 値。 app_settings には `infisical.<lower>` キーで保存。 */
export interface InfisicalCreds {
  siteUrl: string;
  projectId: string;
  environment: string;
  clientId: string;
  clientSecret: string;
}

/** app_settings のキー名 ↔ INFISICAL_* env 名 の対応表。 */
export const INFISICAL_SETTING_KEYS = {
  'infisical.site_url': 'INFISICAL_SITE_URL',
  'infisical.project_id': 'INFISICAL_PROJECT_ID',
  'infisical.environment': 'INFISICAL_ENVIRONMENT',
  'infisical.client_id': 'INFISICAL_CLIENT_ID',
  'infisical.client_secret': 'INFISICAL_CLIENT_SECRET',
} as const;

interface InfisicalSecret { secretKey: string; secretValue: string }

/** process.env から machine identity を組み立て (足りなければ null)。 */
function credsFromEnv(): InfisicalCreds | null {
  const siteUrl = process.env.INFISICAL_SITE_URL?.replace(/\/$/, '');
  const projectId = process.env.INFISICAL_PROJECT_ID;
  const environment = process.env.INFISICAL_ENVIRONMENT ?? 'dev';
  const clientId = process.env.INFISICAL_CLIENT_ID;
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
  if (!siteUrl || !projectId || !clientId || !clientSecret) return null;
  return { siteUrl, projectId, environment, clientId, clientSecret };
}

/** 指定 creds で Infisical にログインして全 secret を取得。 */
async function fetchSecrets(creds: InfisicalCreds): Promise<InfisicalSecret[]> {
  const siteUrl = creds.siteUrl.replace(/\/$/, '');
  const loginRes = await fetch(`${siteUrl}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: creds.clientId, clientSecret: creds.clientSecret }),
  });
  if (!loginRes.ok) {
    throw new Error(`Infisical login failed: ${loginRes.status}`);
  }
  const { accessToken } = (await loginRes.json()) as { accessToken: string };

  const params = new URLSearchParams({
    workspaceId: creds.projectId,
    environment: creds.environment,
    secretPath: '/',
  });
  const secretsRes = await fetch(`${siteUrl}/api/v3/secrets/raw?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!secretsRes.ok) {
    throw new Error(`Infisical secrets fetch failed: ${secretsRes.status}`);
  }
  const { secrets } = (await secretsRes.json()) as { secrets: InfisicalSecret[] };
  return secrets;
}

/** secrets を process.env に注入 (既存値は上書きしない = Excubitor / host env 優先)。 */
function injectSecrets(secrets: InfisicalSecret[]): number {
  let injected = 0;
  for (const s of secrets) {
    if (!process.env[s.secretKey]) {
      process.env[s.secretKey] = s.secretValue;
      injected++;
    }
  }
  return injected;
}

export interface EnsureEnvResult {
  /** Infisical から secret を inject できたか */
  ok: boolean;
  injected: number;
  /** ok=false の理由 */
  reason?: 'no_creds' | 'infisical_error';
  message?: string;
}

/**
 * 起動時に 1 回呼ぶ。 process.env の INFISICAL_* creds で Infisical から fetch。
 * creds 不足 / Infisical 到達失敗どちらも throw せず result で返す
 * (= 専用セットアップ画面で後から入力させるため、 ここでは落とさない)。
 */
export async function ensureEnv(): Promise<EnsureEnvResult> {
  const creds = credsFromEnv();
  if (!creds) {
    return { ok: false, injected: 0, reason: 'no_creds' };
  }
  try {
    const secrets = await fetchSecrets(creds);
    const injected = injectSecrets(secrets);
    console.log(`[env-bootstrap] injected ${injected} secrets from Infisical`);
    return { ok: true, injected };
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[env-bootstrap] ${message} — Infisical をスキップして起動`);
    return { ok: false, injected: 0, reason: 'infisical_error', message };
  }
}

/**
 * 専用セットアップ画面から渡された creds で Infisical 接続を試す。
 * 成功したら process.env に creds + 全 secret を inject して result を返す。
 * 失敗時は throw (= 画面側でエラー表示)。
 */
export async function applyInfisicalCreds(creds: InfisicalCreds): Promise<{ injected: number }> {
  const secrets = await fetchSecrets(creds);
  // creds 自体も env に載せる (= 後続の ensureEnv 相当処理や再 fetch 用)
  process.env.INFISICAL_SITE_URL = creds.siteUrl;
  process.env.INFISICAL_PROJECT_ID = creds.projectId;
  process.env.INFISICAL_ENVIRONMENT = creds.environment;
  process.env.INFISICAL_CLIENT_ID = creds.clientId;
  process.env.INFISICAL_CLIENT_SECRET = creds.clientSecret;
  const injected = injectSecrets(secrets);
  console.log(`[env-bootstrap] applyInfisicalCreds: injected ${injected} secrets`);
  return { injected };
}

/**
 * machine identity (INFISICAL_*) が process.env に揃っているか。
 * セットアップ gate はこれが false のときだけ出す。 揃っていれば — たとえ
 * Infisical に CERNERE_BASE_URL 等が未登録でも — gate は出さない
 * (= ローカル専用機能まで止めない。 Hub 連携が degraded になるだけ)。
 */
export function hasInfisicalCreds(): boolean {
  return credsFromEnv() !== null;
}

/** 未設定の WANTED_KEYS を返す (起動ログ用 — 何が degraded か明示)。 */
export function missingWantedKeys(): string[] {
  return WANTED_KEYS.filter((k) => !process.env[k]);
}
