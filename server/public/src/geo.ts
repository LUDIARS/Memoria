// ブラウザ位置情報の取得を「許可済みのときだけ silent 取得、 そうでなければ
// 黙ってスキップ」 するためのヘルパ。
//
// 問題: 旧コードは `_silentCheckin` (workplace 自動チェックイン) が
// visibilitychange のたびに無条件で `getCurrentPosition` を叩いていたため、
// permission が 'granted' でないとき (HTTP origin / iOS / strict ブラウザ
// 設定) はタブ復帰ごとに permission 再確認ダイアログや「位置情報を使って
// います」 indicator が表示されていた。
//
// 修正:
//   - Permissions API (`navigator.permissions.query`) で許可状況を確認
//   - silent 呼び出しは 'granted' のときだけ実行 (= ダイアログを出さない)
//   - 5 分間隔の throttle (visibilitychange の連発を抑制)
//   - silent は enableHighAccuracy=false + maximumAge=5min で軽量化
//
// 手動ボタン (= 「現在地」 ボタン) からは従来どおり `requestPosition` を
// 直接呼ぶ。 こちらは permission が 'prompt' でもダイアログを出していい
// (= ユーザの明示的なアクション)。

export type GeoPermissionState = 'granted' | 'prompt' | 'denied' | 'unknown';

/** 'unknown' は Permissions API 未対応 (古い iOS Safari 等) を意味する */
export async function getGeoPermissionState(): Promise<GeoPermissionState> {
  const perms = (navigator as unknown as { permissions?: { query: (q: { name: string }) => Promise<{ state: string }> } }).permissions;
  if (!perms?.query) return 'unknown';
  try {
    const r = await perms.query({ name: 'geolocation' });
    if (r.state === 'granted' || r.state === 'prompt' || r.state === 'denied') return r.state;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface PositionLike {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

/**
 * ダイアログを出さない silent 取得。
 *   - permission が 'granted' か (キャッシュされた最近の位置がある) ときだけ
 *     呼び出す。 'prompt' / 'denied' / Geolocation API 自体が無い → null を返す
 *   - 軽量設定: enableHighAccuracy=false, maximumAge=5min, timeout=8s
 *
 * 5 分以内に成功した結果がメモリにあればそれを返す (= getCurrentPosition の
 * ネイティブ呼び出し自体を回避)。
 */
export async function silentGetPosition(): Promise<PositionLike | null> {
  if (!('geolocation' in navigator)) return null;
  const fresh = cached();
  if (fresh) return fresh;
  const perm = await getGeoPermissionState();
  // 'unknown' は古い iOS Safari 等。 Permissions API 無しなので試すしかないが、
  // それでも silent ヒントを残したいので enableHighAccuracy=false で 1 回試す。
  if (perm === 'denied' || perm === 'prompt') return null;
  return new Promise<PositionLike | null>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p: PositionLike = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        writeCache(p);
        resolve(p);
      },
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60_000 },
    );
  });
}

/**
 * ユーザの明示的アクション (= 「現在地」 ボタン) で呼ぶ。 permission='prompt' なら
 * 許可ダイアログを出す。 高精度で取得し、 cache にも書く。
 */
export async function requestPosition(opts?: PositionOptions): Promise<PositionLike> {
  if (!('geolocation' in navigator)) throw new Error('このブラウザは Geolocation に対応していません');
  return new Promise<PositionLike>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p: PositionLike = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        writeCache(p);
        resolve(p);
      },
      (err) => reject(new Error(err.message || 'GPS 取得失敗')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30_000, ...(opts ?? {}) },
    );
  });
}

// ── In-memory + localStorage cache (5 分有効) ───────────────────────────
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_KEY = 'memoria.geo.last';
interface CacheRow { lat: number; lon: number; ts: number; acc?: number }

function cached(): PositionLike | null {
  const ram = ramCache;
  if (ram && Date.now() - ram.ts < CACHE_TTL_MS) {
    return { latitude: ram.lat, longitude: ram.lon, accuracy: ram.acc };
  }
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const row = JSON.parse(raw) as CacheRow;
    if (Date.now() - row.ts >= CACHE_TTL_MS) return null;
    ramCache = row;
    return { latitude: row.lat, longitude: row.lon, accuracy: row.acc };
  } catch {
    return null;
  }
}

let ramCache: CacheRow | null = null;
function writeCache(p: PositionLike): void {
  ramCache = { lat: p.latitude, lon: p.longitude, ts: Date.now(), acc: p.accuracy };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(ramCache)); } catch { /* iOS private */ }
}
