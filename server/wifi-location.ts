// PC の WiFi スキャン結果から位置情報を推定して gps_locations に積む。
//
// 設計:
//   1. Windows native の `netsh wlan show networks mode=bssid` で BSSID + 信号強度
//      を取得する。 macOS / Linux は今回スコープ外 (将来 airport / iw 等で対応)。
//   2. Google Geolocation API (`https://www.googleapis.com/geolocation/v1/geolocate?key=…`)
//      に BSSID リストを POST して lat/lng/accuracy を得る。
//   3. 結果を device_id='pc-wifi' で gps_locations に insert + /ws/locations に
//      broadcast する。 OwnTracks の 1 点と同じパスを通る。
//
// なぜ必要か:
//   モバイルが手元に無い (= OwnTracks の点が来ない) ときでも、 PC が動いている
//   間は 10 分おきに大体の居場所が gps_locations に積まれる。 「いつどこで作業
//   していたか」 の補完情報になる。
//
// 環境変数:
//   MEMORIA_WIFI_LOCATION              'off' で完全停止 (default: API key があれば起動)
//   MEMORIA_GOOGLE_GEOLOCATION_API_KEY Google Geolocation API key (未設定なら disable)
//   MEMORIA_WIFI_INTERVAL_SEC          実行間隔。 default 600 (10 分)
//   MEMORIA_WIFI_DEVICE_ID             gps_locations.device_id (default 'pc-wifi')
//   MEMORIA_USER_ID                    gps_locations.user_id (default 'me')
//   MEMORIA_WIFI_MIN_AP                BSSID 件数の下限。 default 2 (Google は 2 件以上推奨)

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type BetterSqlite3 from 'better-sqlite3';
import { insertGpsLocation } from './db.js';
import type { LocationBroadcastPoint } from './lib/ws-locations.js';

const exec = promisify(execCb);

type Db = BetterSqlite3.Database;

export interface WifiLocationDeps {
  db: Db;
  broadcastLocation: (point: LocationBroadcastPoint) => void;
  triggerResolveAsync: (id: number, lat: number, lon: number) => void;
}

export interface WifiAccessPoint {
  macAddress: string;
  /** dBm。 例: -55 */
  signalStrength?: number;
}

export interface GeolocateResponse {
  location: { lat: number; lng: number };
  accuracy: number;
}

export interface WifiLocationHandle {
  stop(): void;
  /** テスト / 手動用。 1 回だけ run して結果を返す */
  runOnce(): Promise<{ inserted: boolean; reason?: string; lat?: number; lon?: number }>;
}

const DEFAULT_INTERVAL_SEC = 600;
const DEFAULT_MIN_AP = 2;
const DEFAULT_DEVICE_ID = 'pc-wifi';

export function startWifiLocation(deps: WifiLocationDeps): WifiLocationHandle | null {
  const env = process.env;
  if (env.MEMORIA_WIFI_LOCATION === 'off') return null;
  const apiKey = env.MEMORIA_GOOGLE_GEOLOCATION_API_KEY ?? '';
  if (!apiKey) {
    console.log('[wifi-location] disabled (MEMORIA_GOOGLE_GEOLOCATION_API_KEY not set)');
    return null;
  }
  if (process.platform !== 'win32') {
    console.log(`[wifi-location] disabled (platform=${process.platform}, only win32 supported)`);
    return null;
  }

  const intervalSec = Math.max(60, Number(env.MEMORIA_WIFI_INTERVAL_SEC ?? DEFAULT_INTERVAL_SEC));
  const minAp = Math.max(1, Number(env.MEMORIA_WIFI_MIN_AP ?? DEFAULT_MIN_AP));
  const deviceId = env.MEMORIA_WIFI_DEVICE_ID ?? DEFAULT_DEVICE_ID;
  const userId = env.MEMORIA_USER_ID ?? 'me';

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function runOnce(): Promise<{ inserted: boolean; reason?: string; lat?: number; lon?: number }> {
    let aps: WifiAccessPoint[];
    try {
      aps = await scanWindowsWifi();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { inserted: false, reason: `scan_failed: ${msg}` };
    }
    if (aps.length < minAp) return { inserted: false, reason: `too_few_ap (${aps.length})` };

    let geo: GeolocateResponse;
    try {
      geo = await callGoogleGeolocation(apiKey, aps);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { inserted: false, reason: `geolocate_failed: ${msg}` };
    }

    const tst = Math.floor(Date.now() / 1000);
    const rawJson = JSON.stringify({
      via: 'wifi-location',
      ap_count: aps.length,
      provider: 'google-geolocation',
    });
    const result = insertGpsLocation(deps.db, {
      userId,
      deviceId,
      tst,
      lat: geo.location.lat,
      lon: geo.location.lng,
      accuracy: geo.accuracy,
      altitude: null,
      velocity: null,
      course: null,
      battery: null,
      conn: null,
      rawJson,
    });
    if ('skipped' in result) return { inserted: false, reason: 'duplicate' };

    deps.broadcastLocation({
      id: result.id,
      user_id: userId,
      device_id: deviceId,
      recorded_at: new Date(tst * 1000).toISOString(),
      lat: geo.location.lat,
      lon: geo.location.lng,
      accuracy_m: geo.accuracy,
      altitude_m: null,
      velocity_kmh: null,
      course_deg: null,
    });
    deps.triggerResolveAsync(result.id, geo.location.lat, geo.location.lng);
    console.log(
      `[wifi-location] insert id=${result.id} ap=${aps.length} ` +
      `(${geo.location.lat.toFixed(5)}, ${geo.location.lng.toFixed(5)}) acc=${Math.round(geo.accuracy)}m`,
    );
    return { inserted: true, lat: geo.location.lat, lon: geo.location.lng };
  }

  async function loop(): Promise<void> {
    if (stopped) return;
    try {
      const r = await runOnce();
      if (!r.inserted && r.reason && r.reason !== 'duplicate') {
        console.log(`[wifi-location] skip: ${r.reason}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[wifi-location] loop iteration failed: ${msg}`);
    }
    if (stopped) return;
    timer = setTimeout(loop, intervalSec * 1000);
    timer.unref?.();
  }

  // 初回は 5 秒後 (server boot のノイズを避ける)
  timer = setTimeout(loop, 5000);
  timer.unref?.();
  console.log(`[wifi-location] starting (interval=${intervalSec}s, min_ap=${minAp}, device_id=${deviceId})`);

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    runOnce,
  };
}

/**
 * Windows: `netsh wlan show networks mode=bssid` の出力をパースして BSSID / RSSI を抽出する。
 * netsh はロケールによって出力フォーマットが異なる (日本語 / 英語)。 BSSID 行と
 * 信号 (%)行だけは "BSSID" / "Signal" の文字列に依存しないよう、 行頭インデント +
 * 値の正規表現で拾う。
 */
export async function scanWindowsWifi(): Promise<WifiAccessPoint[]> {
  const { stdout } = await exec('netsh wlan show networks mode=bssid', {
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return parseNetshOutput(stdout);
}

export function parseNetshOutput(text: string): WifiAccessPoint[] {
  const aps: WifiAccessPoint[] = [];
  const lines = text.split(/\r?\n/);
  // BSSID は 6 オクテット (16 進、 ':' 区切り)
  const bssidRe = /([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i;
  // Signal は数字 + '%' (例: "信号 : 78%" / "Signal : 78%")
  const signalRe = /(\d{1,3})\s*%/;

  let currentBssid: string | null = null;
  let currentSignal: number | null = null;

  function flush(): void {
    if (currentBssid) {
      const ap: WifiAccessPoint = { macAddress: currentBssid.toLowerCase() };
      if (currentSignal != null) {
        // Windows は signal を 0-100% で返すので dBm 換算する。
        // 100% ≈ -50 dBm, 0% ≈ -100 dBm の単純線形補間。
        ap.signalStrength = Math.round(-100 + currentSignal * 0.5);
      }
      aps.push(ap);
    }
    currentBssid = null;
    currentSignal = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const bm = bssidRe.exec(line);
    if (bm) {
      flush();
      currentBssid = bm[1];
      continue;
    }
    if (currentBssid) {
      const sm = signalRe.exec(line);
      if (sm) {
        const v = Number(sm[1]);
        if (Number.isFinite(v) && v >= 0 && v <= 100) currentSignal = v;
      }
    }
  }
  flush();

  // BSSID 重複を排除 (同一 AP の複数チャンネル分が出る場合がある)
  const seen = new Set<string>();
  return aps.filter((a) => {
    if (seen.has(a.macAddress)) return false;
    seen.add(a.macAddress);
    return true;
  });
}

async function callGoogleGeolocation(
  apiKey: string,
  aps: WifiAccessPoint[],
): Promise<GeolocateResponse> {
  const url = `https://www.googleapis.com/geolocation/v1/geolocate?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      considerIp: false,
      wifiAccessPoints: aps.map((a) => ({
        macAddress: a.macAddress,
        signalStrength: a.signalStrength,
      })),
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    throw new Error(`google geolocation HTTP ${res.status}: ${body}`);
  }
  const json = (await res.json()) as Partial<GeolocateResponse>;
  if (
    !json ||
    !json.location ||
    typeof json.location.lat !== 'number' ||
    typeof json.location.lng !== 'number' ||
    typeof json.accuracy !== 'number'
  ) {
    throw new Error('google geolocation returned malformed body');
  }
  return json as GeolocateResponse;
}
