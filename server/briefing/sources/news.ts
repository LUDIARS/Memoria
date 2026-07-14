// ニュースソース。 直近 N 分に取り込んだ RSS 記事を列挙する。
// fetched_at ベースで「ついさっき入ってきたニュース」 を出すのが狙い。

import type BetterSqlite3 from 'better-sqlite3';
import type { SectionBlock } from '../types.js';
import { listArticlesSinceMinutes } from '../../rss/index.js';

type Db = BetterSqlite3.Database;

const MAX_ITEMS = 8;

export function buildNewsBlock(db: Db, windowMinutes: number): SectionBlock {
  const heading = `📰 直近${windowMinutes}分のニュース`;
  try {
    const articles = listArticlesSinceMinutes(db, windowMinutes, MAX_ITEMS);
    if (!articles.length) {
      return { key: 'news', heading, lines: ['（この時間帯の新着はありません）'] };
    }
    const lines = articles.map((a) => {
      const src = a.feed_title ? `（${a.feed_title}）` : '';
      return `・${a.title}${src}`;
    });
    return { key: 'news', heading, lines };
  } catch (e: unknown) {
    return { key: 'news', heading, lines: [`⚠️ 取得失敗（${e instanceof Error ? e.message : String(e)}）`] };
  }
}
