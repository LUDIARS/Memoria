// /api/attendance/* — Aedilis 出席チェックイン受信
//
// 契約書: E:\Document\Ars\Aedilis\checkin-spike\CONTRACTS.md §5
// Aedilis cloud が出席確定時に webhook を fire-and-forget で投げてくる:
//   POST { type:'attendance.checked_in', userId, facilityId,
//          checkedInAt, reservationId|null, source:'aedilis' }
// これを「在席ログ (presence) の 1 種」 としてローカル SQLite に 1 件記録する。
//
// ── relay 経由について (本番化 TODO) ─────────────────────────────────────
// Memoria 本体はローカルログ専用で、 online への直接 write は不可
// ([[feedback_memoria_online_flow]]: 直接書込みは削除済、 relay 経由が正)。
// このエンドポイントは「ローカル ingest 受け口」 であり、 GPS の
// /api/locations/ingest や Legatus の /api/visits/external と同じ系統
// (= 外部フォワーダが叩く認証付き受信点) に揃えてある。
// 本番では Aedilis が直接ここへ POST するのではなく、 Imperativus / Legatus
// 系の relay フォワーダ経由でこのエンドポイントへ届ける構成に寄せること。
// 受信点の I/F (body + ingest key 認証) はそのまま流用できる。
//
// 認証: locations と同じ ingest key (X-Memoria-Ingest-Key / Bearer / Basic)。
// キー未設定時は LAN-only 前提で素通り ([[checkIngestKey]] の既定挙動)。

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { recordAttendanceEvent, listAttendanceEvents } from '../db.js';
import { checkIngestKey } from '../lib/ingest-auth.js';

type Db = BetterSqlite3.Database;

export interface AttendanceRouterDeps {
  db: Db;
}

export function makeAttendanceRouter(deps: AttendanceRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  // 出席イベント受信 (Aedilis webhook / relay フォワーダ)。
  r.post('/api/attendance/ingest', async (c: Context) => {
    const denied = checkIngestKey(db, c);
    if (denied) return denied;

    const body = await c.req.json().catch(() => null) as {
      type?: unknown; userId?: unknown; facilityId?: unknown;
      checkedInAt?: unknown; reservationId?: unknown; source?: unknown;
    } | null;
    if (!body) return c.json({ error: 'invalid json' }, 400);

    // type は契約上 'attendance.checked_in' のみ。 未知 type は明示的に弾く
    // (将来 leave 等を足す時はここで分岐する)。
    if (body.type != null && body.type !== 'attendance.checked_in') {
      return c.json({ error: `unsupported type: ${String(body.type)}` }, 400);
    }

    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    const facilityId = typeof body.facilityId === 'string' ? body.facilityId.trim() : '';
    const checkedInAt = Number(body.checkedInAt);
    if (!userId) return c.json({ error: 'userId required' }, 400);
    if (!facilityId) return c.json({ error: 'facilityId required' }, 400);
    if (!Number.isFinite(checkedInAt) || checkedInAt <= 0) {
      return c.json({ error: 'checkedInAt (epoch ms) required' }, 400);
    }

    // reservationId は null / 文字列のみ受ける (walk-in は null)。 生 PII は
    // 受け取らない — userId アンカー + 施設 + 時刻 + 予約 ID のみ保存する。
    const reservationId = typeof body.reservationId === 'string' && body.reservationId.trim()
      ? body.reservationId.trim()
      : null;
    const source = typeof body.source === 'string' && body.source.trim()
      ? body.source.trim().slice(0, 50)
      : 'aedilis';

    const result = recordAttendanceEvent(db, {
      userId, facilityId, checkedInAt, reservationId, source,
    });
    return c.json({ ok: true, id: result.id, deduped: !result.inserted });
  });

  // 受信済み出席イベント一覧 (UI / 動作確認用、 ローカル read)。
  r.get('/api/attendance/recent', (c: Context) => {
    const limit = Number(c.req.query('limit')) || 50;
    const facility = c.req.query('facility') || null;
    return c.json({ items: listAttendanceEvents(db, { limit, facilityId: facility }) });
  });

  return r;
}
