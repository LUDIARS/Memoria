import { Hono, type Context } from 'hono';

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
