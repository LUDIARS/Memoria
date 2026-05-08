// /api/locations/ingest 系の API key 認証。
//
// 個人 PC ローカル前提だが LAN 開放 / Cloudflare Tunnel 公開時に保護したい。
// Key の解決順:
//   a. app_settings.`locations.ingest_key` (UI から生成 / 設定)
//   b. 環境変数 LOCATIONS_INGEST_KEY (CI / CLI 用)
//   c. どちらも空 → 認証無効 (LAN-only バインドが前提)

import type { Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings } from '../db.js';

type Db = BetterSqlite3.Database;

export interface BasicAuth {
  user: string;
  pass: string;
}

export function decodeBasicAuth(headerVal: string | null | undefined): BasicAuth | null {
  if (!headerVal || !headerVal.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(headerVal.slice(6).trim(), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

export function getIngestKey(db: Db): string {
  const stored = (getAppSettings(db)['locations.ingest_key'] || '').trim();
  if (stored) return stored;
  return (process.env.LOCATIONS_INGEST_KEY ?? '').trim();
}

/**
 * 認証 OK なら null を返す。 不一致なら 401 Response を返す。
 *
 * 認証経路は 3 通りで、 いずれか一致すれば OK:
 *   1. `X-Memoria-Ingest-Key: <key>`         (curl 等カスタムヘッダ向け)
 *   2. `Authorization: Bearer <key>`         (一般的な API client)
 *   3. `Authorization: Basic base64(u:<key>)` (OwnTracks iOS HTTP モードはこれ)
 */
export function checkIngestKey(db: Db, c: Context): Response | null {
  const key = getIngestKey(db);
  if (!key) return null;
  // 1) custom header
  const xKey = c.req.header('x-memoria-ingest-key') ?? '';
  if (xKey && xKey === key) return null;
  // 2/3) Authorization
  const auth = c.req.header('authorization') ?? '';
  if (auth.startsWith('Bearer ')) {
    const tok = auth.slice(7).trim();
    if (tok === key) return null;
  }
  const basic = decodeBasicAuth(auth);
  if (basic && basic.pass === key) return null;
  // OwnTracks iOS は 401 を見ると basic auth ダイアログを出さず再試行するので
  // realm 付きで返しておく (ログから "認証要求" が判別しやすくなる)。
  return c.json({ error: 'invalid ingest key' }, 401, {
    'WWW-Authenticate': 'Basic realm="memoria-locations"',
  });
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '*'.repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
