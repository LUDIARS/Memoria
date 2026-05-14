/**
 * env-bootstrap — `.env` ファイル無しで Memoria server を起動するための env 注入。
 *
 * 設定値 (CERNERE_BASE_URL / MEMORIA_PLACES_API_KEY 等) は Infisical に置く。
 * `.env` には何も入れない。 Infisical に到達するための machine identity 認証情報
 * (INFISICAL_*) だけは Infisical に入れられない (= chicken-and-egg) ので、
 * `server/.env.secrets` ファイル or host shell env or Excubitor inject で渡す。
 *
 * 注入経路:
 *   (A) Excubitor 経由: catalog.infisical.inject=true で 親が全 secret を child env に注入
 *   (B) 単独起動:        `.env.secrets` (npm script の --env-file-if-exists で読む) or host env
 *
 * Cernere/Actio/Imperativus/Nuntius と同じパターン (LUDIARS/Cernere#79)。
 *
 * 動作:
 *   - INFISICAL_* creds が揃っていれば、 起動時に必ず Infisical から全 secret を
 *     fetch して process.env に inject (既存値は上書きしない = host env / Excubitor 優先)。
 *   - creds が無い場合は WANTED_KEYS のうち未設定のものを警告するだけで、 起動は止めない
 *     (= Memoria は個人ローカル前提。 Hub 連携 / 一部 Google API が使えないだけ)。
 */

/**
 * Infisical から取れていてほしい設定キー。 起動を止めはしないが、
 * 揃っていなければ警告を出す (= 何が動かないかを起動ログで分かるように)。
 */
const WANTED_KEYS: readonly string[] = [
  'CERNERE_BASE_URL',          // Memoria Hub の認証で叩く Cernere の base URL
  'MEMORIA_PLACES_API_KEY',    // server-side Google key (Routes/Places/Geocoding、 referer 制限なし)
];

interface InfisicalSecret { secretKey: string; secretValue: string }

async function fetchInfisicalSecrets(): Promise<InfisicalSecret[] | null> {
  const siteUrl = process.env.INFISICAL_SITE_URL?.replace(/\/$/, '');
  const projectId = process.env.INFISICAL_PROJECT_ID;
  const environment = process.env.INFISICAL_ENVIRONMENT ?? 'dev';
  const clientId = process.env.INFISICAL_CLIENT_ID;
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET;

  if (!siteUrl || !projectId || !clientId || !clientSecret) {
    return null; // creds 不足 — 呼び出し側で soft-warn
  }

  const loginRes = await fetch(`${siteUrl}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!loginRes.ok) {
    throw new Error(`[env-bootstrap] Infisical login failed: ${loginRes.status}`);
  }
  const { accessToken } = (await loginRes.json()) as { accessToken: string };

  const params = new URLSearchParams({ workspaceId: projectId, environment, secretPath: '/' });
  const secretsRes = await fetch(`${siteUrl}/api/v3/secrets/raw?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!secretsRes.ok) {
    throw new Error(`[env-bootstrap] Infisical secrets failed: ${secretsRes.status}`);
  }
  const { secrets } = (await secretsRes.json()) as { secrets: InfisicalSecret[] };
  return secrets;
}

export async function ensureEnv(): Promise<void> {
  let secrets: InfisicalSecret[] | null = null;
  try {
    secrets = await fetchInfisicalSecrets();
  } catch (err) {
    // Infisical 到達失敗は致命にしない (= ローカル個人開発を止めない)。
    console.warn(`[env-bootstrap] ${(err as Error).message} — Infisical をスキップして起動`);
  }

  if (secrets) {
    let injected = 0;
    for (const s of secrets) {
      // 既存 env (host shell / Excubitor inject) を優先。 上書きしない。
      if (!process.env[s.secretKey]) {
        process.env[s.secretKey] = s.secretValue;
        injected++;
      }
    }
    console.log(`[env-bootstrap] injected ${injected} secrets from Infisical`);
  } else {
    console.warn(
      '[env-bootstrap] INFISICAL_* creds 未設定 — Infisical からの secret 取得をスキップ。\n' +
      '  Hub 連携 / 一部 Google API を使うには server/.env.secrets に machine identity を置くか、\n' +
      '  Excubitor 経由 (catalog.infisical.inject=true) で起動してください。',
    );
  }

  // WANTED_KEYS のうち最終的に未設定のものを警告 (= 何が動かないか起動ログで明示)。
  const missing = WANTED_KEYS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.warn(`[env-bootstrap] 未設定の設定キー: ${missing.join(', ')} (= 関連機能は無効のまま起動)`);
  }
}
