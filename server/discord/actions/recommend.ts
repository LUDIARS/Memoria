// おすすめ生成。 既存 runAiRecommendations を直接呼ぶ (top-level モジュールなので
// domain cross-import には該当しない)。 結果サマリ文字列を返す。

import type BetterSqlite3 from 'better-sqlite3';
import { runAiRecommendations, isAiRecommendationsAvailable } from '../../recommendations-ai.js';

type Db = BetterSqlite3.Database;

export async function runRecommend(db: Db): Promise<string> {
  const avail = isAiRecommendationsAvailable();
  if (!avail.available) return `おすすめ生成不可: ${avail.reason}`;
  const result = await runAiRecommendations(db, { force: true });
  const items = result.items ?? [];
  if (items.length === 0) return 'おすすめは見つかりませんでした';
  const lines = items.slice(0, 5).map((it, i) => `${i + 1}. ${it.title ?? ''}`);
  return ['🎯 おすすめ', ...lines].join('\n');
}
