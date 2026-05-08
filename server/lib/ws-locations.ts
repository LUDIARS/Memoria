// /ws/locations broadcaster — 新着 GPS 点 / 場所解決完了の WebSocket イベント。
//
// httpServer.on('upgrade') で attach する WebSocketServer 1 個を共有する。
// Tracks 画面と外部 WS subscriber が直接見ているのもこの port。

import type { WebSocket } from 'ws';
import type BetterSqlite3 from 'better-sqlite3';
import { resolvePlaceForRow } from './place-resolver.js';
import type { PlaceResolveResult } from './place-resolver.js';

type Db = BetterSqlite3.Database;

export type { PlaceResolveResult };

export interface LocationBroadcastPoint {
  id: number;
  user_id: string;
  device_id: string | null;
  recorded_at: string;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  altitude_m: number | null;
  velocity_kmh: number | null;
  course_deg: number | null;
}

export interface WsLocationsBundle {
  /** Caller (httpServer 'connection' handler) で `wsClients.add(ws)` する */
  wsClients: Set<WebSocket>;
  broadcastLocation: (point: LocationBroadcastPoint) => void;
  broadcastLocationResolved: (id: number, result: PlaceResolveResult | null) => void;
  /** 新着点 1 件を fire-and-forget で逆ジオコーディングし、 完了後に broadcast する */
  triggerResolveAsync: (id: number, lat: number, lon: number) => void;
}

export function makeWsLocations(db: Db): WsLocationsBundle {
  const wsClients = new Set<WebSocket>();

  function broadcastLocation(point: LocationBroadcastPoint): void {
    if (wsClients.size === 0) return;
    const msg = JSON.stringify({ type: 'location', point });
    for (const c of wsClients) {
      if (c.readyState === 1 /* OPEN */) {
        try { c.send(msg); } catch { /* ignore */ }
      }
    }
  }

  function broadcastLocationResolved(id: number, result: PlaceResolveResult | null): void {
    if (wsClients.size === 0) return;
    const msg = JSON.stringify({
      type: 'location.resolved',
      id,
      place_name: result?.name ?? null,
      place_address: result?.address ?? null,
      place_source: result?.source ?? 'failed',
    });
    for (const c of wsClients) {
      if (c.readyState === 1) {
        try { c.send(msg); } catch { /* ignore */ }
      }
    }
  }

  /**
   * 新着 GPS 点 1 件の location 解決を fire-and-forget で起動.
   * insertGpsLocation の戻り値 (`inserted: true, id`) を渡す.
   * resolvePlaceForRow が完了したら WS で `location.resolved` を broadcast.
   */
  function triggerResolveAsync(id: number, lat: number, lon: number): void {
    if (!Number.isFinite(id) || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    setImmediate(async () => {
      try {
        const r = await resolvePlaceForRow(db, { id, lat, lon });
        broadcastLocationResolved(id, r);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[place-resolver] id=${id} failed: ${msg}`);
      }
    });
  }

  return { wsClients, broadcastLocation, broadcastLocationResolved, triggerResolveAsync };
}
