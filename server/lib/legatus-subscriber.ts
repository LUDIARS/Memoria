// Legatus WS subscriber (recommended path for OwnTracks → Memoria).
//
// 同じ PC 上で動く Legatus (loopback 17320) が OwnTracks → MQTT → /ws で
// 個別 GPS 点を broadcast する。 Memoria はそれを subscribe して
// gps_locations に即時 insert + /ws/locations に broadcast →
// Tracks UI の地図にリアルタイムで点が増える設計。
//
// Legatus 側の summary 経路 (5 分集計) は start/end の 2 点しか作らない
// ので、 細かい軌跡が欲しい場合はこちらが正解 (用途が違う path として共存)。

import type BetterSqlite3 from 'better-sqlite3';
import WebSocket from 'ws';
import { insertGpsLocation } from '../db.js';
import type { LocationBroadcastPoint } from './ws-locations.js';

type Db = BetterSqlite3.Database;

interface LegatusEvent {
  type?: string;
  lat?: number | string;
  lon?: number | string;
  device?: string;
  topic_user?: string;
  tst?: number;
  acc?: number;
}

export interface LegatusSubscriberDeps {
  db: Db;
  broadcastLocation: (point: LocationBroadcastPoint) => void;
  triggerResolveAsync: (id: number, lat: number, lon: number) => void;
  /** Memoria 内で gps 行に書く user_id。 default 'me' */
  userId?: string;
  /** 接続先 WS URL。 default `ws://127.0.0.1:17320/ws` */
  url?: string;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export function startLegatusSubscriber(deps: LegatusSubscriberDeps): void {
  const url = deps.url ?? process.env.MEMORIA_LEGATUS_WS_URL ?? 'ws://127.0.0.1:17320/ws';
  const lgUserId = deps.userId ?? process.env.MEMORIA_LEGATUS_USER_ID ?? 'me';
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let ws: WebSocket | null = null;

  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
    attempt += 1;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  function connect(): void {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try { ws = new WebSocket(url); }
    catch { scheduleReconnect(); return; }
    ws.on('open', () => {
      attempt = 0;
      console.log(`[legatus-ws] connected ${url}`);
    });
    ws.on('message', (raw: Buffer) => {
      let ev: LegatusEvent;
      try { ev = JSON.parse(raw.toString('utf8')) as LegatusEvent; } catch { return; }
      if (!ev || typeof ev.type !== 'string') return;
      // owner_user_id は Cernere namespace なので Memoria の 'me' は上書きしない.
      if (ev.type !== 'owntracks.received') return;
      const lat = Number(ev.lat), lon = Number(ev.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const rec = {
        userId: lgUserId,
        deviceId: ev.device || ev.topic_user || 'phone',
        tst: typeof ev.tst === 'number' ? ev.tst : Math.floor(Date.now() / 1000),
        lat, lon,
        accuracy: typeof ev.acc === 'number' ? ev.acc : null,
        altitude: null,
        velocity: null,
        course: null,
        battery: null,
        conn: null,
        rawJson: JSON.stringify({ via: 'legatus-ws', topic_user: ev.topic_user, device: ev.device }),
      };
      const result = insertGpsLocation(deps.db, rec);
      if (!('skipped' in result)) {
        deps.broadcastLocation({
          id: result.id,
          user_id: rec.userId,
          device_id: rec.deviceId,
          recorded_at: new Date(rec.tst * 1000).toISOString(),
          lat: rec.lat,
          lon: rec.lon,
          accuracy_m: rec.accuracy,
          altitude_m: null,
          velocity_kmh: null,
          course_deg: null,
        });
        deps.triggerResolveAsync(result.id, rec.lat, rec.lon);
        console.log(`[legatus-ws] insert id=${result.id} ${rec.deviceId} (${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)})`);
      }
    });
    ws.on('close', () => {
      ws = null;
      scheduleReconnect();
    });
    ws.on('error', () => { /* close handler に任せる */ });
  }

  connect();
  console.log(`[legatus-ws] subscriber started (url=${url})`);
}
