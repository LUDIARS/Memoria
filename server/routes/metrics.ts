import { Hono, type Context } from 'hono';
import { resolveServiceVersion } from '../service-version.js';

/**
 * メモリ計測エンドポイント (Excubitor Tier2 監視の供給元)。
 *
 * Excubitor のメモリ監視は外形 RSS (プロセスツリー合算) だけでは JS heap か native
 * (external/arrayBuffers) かを切り分けられない。 本エンドポイントが process.memoryUsage()
 * を晒し、 Excubitor catalog の `memory.metrics_url` から取得させることで heap 内訳を可視化する。
 *
 * 規約: GET /api/metrics/memory → { rss, heapUsed, heapTotal, external, arrayBuffers } (各バイト)。
 */
export function makeMetricsRouter(): Hono {
  const r = new Hono();

  r.get('/api/health', (c: Context) => {
    return c.json({
      // AIFormat RULE_SRE.md §2 は ok / service / version を求める。 version が無いと
      // Excubitor もサービス版の横断照会も 「ビルドしたが再起動していない」 を
      // 機械的に検出できない。 既存の status は読んでいる側があるので残す。
      ok: true,
      status: 'ok',
      service: 'memoria-server',
      version: resolveServiceVersion(),
    });
  });

  r.get('/api/metrics/memory', (c: Context) => {
    const m = process.memoryUsage();
    return c.json({
      rss: m.rss,
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      external: m.external,
      arrayBuffers: m.arrayBuffers,
    });
  });

  return r;
}
