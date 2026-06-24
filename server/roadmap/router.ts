// /api/roadmaps — 事業ライン別 private ロードマップの consolidated 進捗を返す。
// 正本は LUDIARS_ROOT/roadmap-*/data/*.json (live スキャン、 常に最新)。
// 「目標」タブ (public/src/goals-view.ts) が読む。

import { Hono, type Context } from 'hono';
import { aggregateRoadmaps } from './aggregate.js';

export function makeRoadmapRouter(): Hono {
  const r = new Hono();

  r.get('/api/roadmaps', (c: Context) => {
    try {
      return c.json(aggregateRoadmaps());
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 設定不備 (root 不在等) は無言フォールバックせず 503 で明示する。
      return c.json({ error: message }, 503);
    }
  });

  return r;
}
