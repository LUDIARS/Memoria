// /api/staleness — 「常駐 frontend が定期的に叩いて『何が変わったか』 を知る」 ping。
//
// 返すのは各機能の **不透明な signature 文字列**。 frontend は前回値と !==
// で比較するだけで、 内容のパース解釈は要らない。 signature が変わってい
// たら該当機能を heavy load し直す方式。
//
// 対象 (= 「逐次発行されるけど WS push してない」 もの):
//   review        : ludiars-review cron が repo の review/*.md を逐次書く
//   weather       : scheduler が weather_snapshots に append
//   transit_rides : detector cron が transit_rides に append
//
// 外部 API 由来 (Ekispert 運行情報) は signature 化不能 — frontend で
// 純粋 TTL 制御。

import { Hono, type Context } from 'hono';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { listReviewTargets } from '../db.js';

type Db = BetterSqlite3.Database;

const LUDIARS_ROOT = resolve(process.env.LUDIARS_ROOT ?? 'E:/Document/Ars');

export interface StalenessRouterDeps { db: Db }

// FS スキャン結果は 30 秒 cache。 review tree は repo×date×file で
// 数百 stat になるので、 staleness ping のたびに走らせるとさすがに勿体無い。
const REVIEW_SIG_TTL_MS = 30_000;
let _reviewSigCache: { sig: string; expires_at: number } | null = null;

function reviewSignature(db: Db): string {
  if (_reviewSigCache && Date.now() < _reviewSigCache.expires_at) {
    return _reviewSigCache.sig;
  }
  let maxMtime = 0;
  let fileCount = 0;
  try {
    for (const t of listReviewTargets(db, { enabledOnly: true })) {
      const reviewDir = isAbsolute(t.local_path)
        ? join(t.local_path, 'review')
        : join(LUDIARS_ROOT, t.local_path, 'review');
      if (!existsSync(reviewDir)) continue;
      let dateDirs: string[];
      try { dateDirs = readdirSync(reviewDir); } catch { continue; }
      for (const d of dateDirs) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
        const dPath = join(reviewDir, d);
        let dStat;
        try { dStat = statSync(dPath); } catch { continue; }
        if (!dStat.isDirectory()) continue;
        let files: string[];
        try { files = readdirSync(dPath); } catch { continue; }
        for (const f of files) {
          if (!/^REVIEW(_[A-Z_]+)?\.md$/.test(f)) continue;
          try {
            const s = statSync(join(dPath, f));
            if (s.mtimeMs > maxMtime) maxMtime = s.mtimeMs;
            fileCount++;
          } catch { /* skip */ }
        }
      }
    }
  } catch { /* swallow */ }
  const sig = `${Math.floor(maxMtime)}-${fileCount}`;
  _reviewSigCache = { sig, expires_at: Date.now() + REVIEW_SIG_TTL_MS };
  return sig;
}

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
   * 軽量化のため SQL は MAX()/COUNT() のみ、 FS は 30s cache 経由。
   */
  r.get('/api/staleness', (c: Context) => {
    return c.json({
      review:        reviewSignature(db),
      weather:       weatherSignature(db),
      transit_rides: transitRidesSignature(db),
      served_at:     Date.now(),
    });
  });

  return r;
}
