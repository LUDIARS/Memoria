// Steam Web API クライアント。
//
// 必要な credentials:
// - Steam Web API key: https://steamcommunity.com/dev/apikey
// - SteamID64 (= 17 桁の数値): https://steamid.io/ 等で取得
//
// 取得対象:
// - GetRecentlyPlayedGames — 直近 2 週間にプレイした game の playtime (分単位)
//   + appid + name + img_icon_url
//
// プライバシ:
// - Steam Web API key はサーバ side の app_settings に保存 (= secret)
// - feature flag `features.activity.steam.enabled` (default false) で opt-in
// - 取得結果は steam_activity テーブルに 1 row / game の snapshot として記録

export interface SteamGameSnapshot {
  appid: number;
  name: string;
  playtime_2weeks_min: number | null;
  playtime_forever_min: number | null;
  img_icon_url: string | null;
}

export interface GetRecentlyPlayedResult {
  ok: boolean;
  error?: string;
  games: SteamGameSnapshot[];
}

/**
 * Steam Web API の `IPlayerService/GetRecentlyPlayedGames/v1` を叩く。
 * - key / steamId が空なら ok=false で何もしない (= 設定未投入時の no-op 経路)。
 * - HTTP / 解析エラーは ok=false で error メッセージを返す。
 */
export async function getRecentlyPlayedGames(
  args: { apiKey: string; steamId: string; count?: number; timeoutMs?: number },
): Promise<GetRecentlyPlayedResult> {
  const apiKey = (args.apiKey || '').trim();
  const steamId = (args.steamId || '').trim();
  if (!apiKey || !steamId) {
    return { ok: false, error: 'apiKey or steamId not configured', games: [] };
  }
  const count = Math.max(1, Math.min(100, args.count ?? 50));
  const url = `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/?key=${encodeURIComponent(apiKey)}&steamid=${encodeURIComponent(steamId)}&count=${count}&format=json`;
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(args.timeoutMs ?? 10_000),
    });
    if (!res.ok) return { ok: false, error: `steam api ${res.status}`, games: [] };
    const json = await res.json() as {
      response?: {
        total_count?: number;
        games?: Array<{
          appid?: number;
          name?: string;
          playtime_2weeks?: number;
          playtime_forever?: number;
          img_icon_url?: string;
        }>;
      };
    };
    const games = (json.response?.games ?? []).flatMap<SteamGameSnapshot>((g) => {
      if (typeof g.appid !== 'number' || typeof g.name !== 'string') return [];
      return [{
        appid: g.appid,
        name: g.name,
        playtime_2weeks_min: typeof g.playtime_2weeks === 'number' ? g.playtime_2weeks : null,
        playtime_forever_min: typeof g.playtime_forever === 'number' ? g.playtime_forever : null,
        img_icon_url: g.img_icon_url ?? null,
      }];
    });
    return { ok: true, games };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `steam api: ${msg}`, games: [] };
  }
}

// ── Store API (= keyless) で appid → name 解決 ──────────────────────────
//
// localconfig.vdf の appid のうち steamapps/appmanifest_<appid>.acf が無い
// (= uninstalled) ものは VDF からは name を出せない。 そこで公開 Store API
// で resolve する。 こちらは API key 不要。
//
// 仕様 (rate limit など): https://wiki.teamfortress.com/wiki/User:RJackson/StorefrontAPI
// 体感で 1 req/sec 程度なら問題なし。 呼び出し側で連投しない。

export interface SteamStoreAppDetails {
  appid: number;
  name: string;
  type: string;                    // 'game' | 'dlc' | 'demo' | 'tool' | 'music' | ...
  header_image: string | null;
  short_description: string | null;
}

export interface FetchAppDetailsResult {
  ok: boolean;
  error?: string;
  /** Store API が `success: false` (= delisted/private) を明示で返した */
  notFound?: boolean;
  details?: SteamStoreAppDetails;
}

export async function fetchAppDetails(
  appid: number,
  opts: { timeoutMs?: number; lang?: string } = {},
): Promise<FetchAppDetailsResult> {
  if (!Number.isFinite(appid) || appid <= 0) {
    return { ok: false, error: 'invalid appid' };
  }
  const lang = (opts.lang || 'japanese').trim();
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=${encodeURIComponent(lang)}`;
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) return { ok: false, error: `store api ${res.status}` };
    const json = await res.json() as Record<string, unknown>;
    const entry = json?.[String(appid)] as { success?: boolean; data?: Record<string, unknown> } | undefined;
    if (!entry) return { ok: false, error: 'store api: empty response' };
    if (entry.success === false) return { ok: true, notFound: true };
    const data = entry.data;
    if (!data || typeof data !== 'object') return { ok: false, error: 'store api: missing data' };
    const name = typeof data.name === 'string' ? data.name : '';
    if (!name) return { ok: false, error: 'store api: missing name' };
    return {
      ok: true,
      details: {
        appid,
        name,
        type: typeof data.type === 'string' ? data.type : 'game',
        header_image: typeof data.header_image === 'string' ? data.header_image : null,
        short_description: typeof data.short_description === 'string' ? data.short_description : null,
      },
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `store api: ${msg}` };
  }
}
