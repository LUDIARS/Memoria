/**
 * Cernere project-token のメモリ専用キャッシュ。
 *
 * Memoria local backend は Cernere に永続的な long-lived service secret を持たない。
 * 代わりに、 ログイン中ユーザの user-JWT を Cernere `/api/auth/project-token` に渡して
 * 「このユーザの memoria-hub 向け short-lived token」 を都度受け取り、 in-memory のみで
 * 保持する。 プロセス再起動で消える / disk に出ない / user・AI ともに値を直接見ない。
 *
 * Cernere 側エンドポイント:
 *   POST /api/auth/project-token
 *   Authorization: Bearer <user-JWT>
 *   body: { project_key: "memoria" }
 *   → { accessToken, expiresIn, projectKey, userId }
 */

const REFRESH_LEEWAY_SEC = 60;

/**
 * Cernere の base URL を毎回 process.env から読む (= module load 時に固定しない)。
 * 専用セットアップ画面で Infisical を後から繋いだとき、 再起動なしで
 * CERNERE_BASE_URL の inject を反映させるため。
 */
function cernereBaseUrl(): string {
  return (process.env.CERNERE_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
}

interface CachedToken {
  accessToken: string;
  expSec: number;
  projectKey: string;
  userId: string;
}

/** key = hubUrl (末尾 `/` 無し). 1 user-context あたり 1 entry。 */
const cache = new Map<string, CachedToken>();
/** 同時呼び出しを 1 本にまとめる */
const inflight = new Map<string, Promise<CachedToken>>();

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function decodeExp(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof p.exp === 'number' ? p.exp : null;
  } catch {
    return null;
  }
}

async function fetchProjectToken(
  userJwt: string,
  projectKey: string,
  hubUrl: string,
): Promise<CachedToken> {
  // Cernere Phase 1 (PR #92) で `hub_url` を audience に入れる仕様になった。
  // 旧 Cernere は無視するので互換性あり。 新 Cernere は PASETO v4 で発行、
  // aud claim が hub_url と一致する。
  const res = await fetch(`${cernereBaseUrl()}/api/auth/project-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userJwt}`,
    },
    body: JSON.stringify({ project_key: projectKey, hub_url: hubUrl }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Cernere /api/auth/project-token failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json() as {
    accessToken: string; expiresIn?: number; projectKey: string; userId: string;
  };
  const exp = decodeExp(data.accessToken) ?? (nowSec() + (data.expiresIn ?? 3600));
  return { accessToken: data.accessToken, expSec: exp, projectKey: data.projectKey, userId: data.userId };
}

/**
 * `hubUrl` 向けの project-token をメモリから返す。 期限切れなら Cernere に再要求。
 *
 * @param hubUrl       Hub の base URL (例 `http://localhost:5280`). キャッシュキー。
 * @param userJwt      Cernere user JWT (ログイン中ユーザの accessToken)。 backend memory にあるもの。
 * @param projectKey   Cernere managed_projects.key (例 `memoria`)
 */
export async function getProjectTokenForHub(
  hubUrl: string,
  userJwt: string,
  projectKey: string,
): Promise<string> {
  const key = hubUrl.replace(/\/$/, '');
  const hit = cache.get(key);
  if (hit && hit.expSec - REFRESH_LEEWAY_SEC > nowSec()) return hit.accessToken;
  const pending = inflight.get(key);
  if (pending) return (await pending).accessToken;

  const task = (async () => {
    try {
      const t = await fetchProjectToken(userJwt, projectKey, key);
      cache.set(key, t);
      return t;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return (await task).accessToken;
}

/** 401/403 を受けたら呼んで次回再取得を強制する。 */
export function invalidateProjectToken(hubUrl: string): void {
  cache.delete(hubUrl.replace(/\/$/, ''));
}

/** 全 Hub の cache を捨てる (disconnect 時)。 */
export function clearAllProjectTokens(): void {
  cache.clear();
  inflight.clear();
}

/** 状況確認用 — token 値そのものは絶対に出さない。 */
export function getCacheSummary(): Array<{ hubUrl: string; projectKey: string; userId: string; expSec: number }> {
  return Array.from(cache.entries()).map(([hubUrl, t]) => ({
    hubUrl,
    projectKey: t.projectKey,
    userId: t.userId,
    expSec: t.expSec,
  }));
}
