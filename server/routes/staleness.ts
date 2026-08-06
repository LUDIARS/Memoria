// /api/staleness — 「常駐 frontend が定期的に叩いて『何が変わったか』 を知る」 ping。
//
// 返すのは各機能の **不透明な signature 文字列**。 frontend は前回値と !==
// で比較するだけで、 内容のパース解釈は要らない。 signature が変わってい
// たら該当機能を heavy load し直す方式。
//
// 対象 (= 「逐次発行されるけど WS push してない」 もの):
//   weather       : scheduler が weather_snapshots に append
//   transit_rides : detector cron が transit_rides に append
//
// 外部 API 由来 (Ekispert 運行情報) は signature 化不能 — frontend で
// 純粋 TTL 制御。

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export interface StalenessRouterDeps { db: Db }

function weatherSignature(db: Db): string {
  const row = db.prepare(
    `SELECT MAX(fetched_at) AS m, COUNT(*) AS n FROM weather_snapshots`,
  ).get() as { m: number | null; n: number };
  return `${row.m ?? 0}-${row.n}`;
}

function transitRidesSignature(db: Db): string {
  const row = db.prepare(
    `SELECT MAX(id) AS mx, COUNT(*) AS n FROM transit_rides`,
  ).get() as { mx: number | null; n: number };
  return `${row.mx ?? 0}-${row.n}`;
}

export function makeStalenessRouter(deps: StalenessRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  /**
   * GET /api/staleness
   *
   * 各機能の signature を 1 リクエストで返す (オブジェクト)。 frontend は
   * 前回値と !== で比較するだけ。
   *
   * 軽量化のため SQL は MAX()/COUNT() のみ。
   */
  r.get('/api/staleness', (c: Context) => {
    return c.json({
      weather:       weatherSignature(db),
      transit_rides: transitRidesSignature(db),
      served_at:     Date.now(),
    });
  });

  return r;
}
