// Cernere 代理ログイン — Hub が Local から受けた email/password を Cernere に渡す。
//
// 二層設計のキモ: ローカル Memoria は Cernere を一切知らない。 Hub が自分の
// Infisical 由来の CERNERE_BASE_URL を使って代理ログインし、 session token を
// ローカルに返す。
//
// CERNERE_BASE_URL は module load 時に固定せず毎回 process.env から読む
// (設定フォームで後から Infisical を繋いだとき、 再起動前でも反映させるため)。

function cernereBaseUrl() {
  return (process.env.CERNERE_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
}

function projectKey() {
  return process.env.MEMORIA_CERNERE_PROJECT_KEY ?? 'memoria';
}

/**
 * Cernere `/api/auth/login` に email/password を渡す。
 * @returns {Promise<{ user: object, accessToken: string, refreshToken?: string }>}
 */
export async function cernereLogin(email, password) {
  let res;
  try {
    res = await fetch(`${cernereBaseUrl()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (err) {
    const e = new Error(`Cernere に到達できません: ${err.message}`);
    e.status = 502;
    throw e;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const e = new Error(
      res.status === 401 ? 'メールアドレスかパスワードが違います'
        : `Cernere login failed: ${res.status}`,
    );
    e.status = res.status === 401 ? 401 : 502;
    e.detail = body.slice(0, 200);
    throw e;
  }
  return res.json();
}

/**
 * Cernere `/api/auth/project-token` で user-JWT を Hub 向け PASETO project-token に交換。
 * @returns {Promise<{ accessToken: string, expiresIn?: number, projectKey: string, userId: string }>}
 */
export async function cernereProjectToken(userJwt, hubUrl) {
  const res = await fetch(`${cernereBaseUrl()}/api/auth/project-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userJwt}`,
    },
    body: JSON.stringify({ project_key: projectKey(), hub_url: hubUrl }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Cernere project-token failed: ${res.status} ${body.slice(0, 160)}`);
  }
  return res.json();
}
