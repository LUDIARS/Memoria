// フィード取得 → 記事 upsert → AI スコアリング → 通知 のパイプライン。
//
// scheduler の定期 tick と、 UI からの手動 refresh の両方が呼ぶ。
// 多重起動を防ぐため pollAllFeeds は in-flight guard を持つ。

import type BetterSqlite3 from 'better-sqlite3';
import { sendPushToAll } from '../push.js';
import { fetchFeedXml } from './sources.js';
import { parseFeedXml } from './parse.js';
import { scoreArticle } from './score.js';
import {
  getFeed, listEnabledFeeds, upsertArticle, markFeedFetched,
  getRssConfig, listPendingArticles, listNotifiableArticles, markArticleNotified,
} from './store.js';

type Db = BetterSqlite3.Database;

export interface PollFeedResult {
  feedId: number;
  ok: boolean;
  total: number;
  newCount: number;
  newIds: number[];
  error?: string;
}

/** 1 フィードを取得して新着を upsert する (スコアリングは呼ばない)。 */
export async function pollFeed(db: Db, feedId: number): Promise<PollFeedResult> {
  const feed = getFeed(db, feedId);
  if (!feed) return { feedId, ok: false, total: 0, newCount: 0, newIds: [], error: 'feed not found' };

  try {
    const xml = await fetchFeedXml(feed.url);
    const parsed = parseFeedXml(xml);
    const newIds: number[] = [];
    const tx = db.transaction(() => {
      for (const a of parsed.articles) {
        if (!a.url && !a.title) continue;
        const { id, isNew } = upsertArticle(db, feedId, a);
        if (isNew) newIds.push(id);
      }
    });
    tx();
    markFeedFetched(db, feedId, {
      status: 'ok',
      error: null,
      title: parsed.title,
      siteUrl: parsed.siteUrl,
      description: parsed.description,
    });
    return { feedId, ok: true, total: parsed.articles.length, newCount: newIds.length, newIds };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    markFeedFetched(db, feedId, { status: 'error', error: msg.slice(0, 300) });
    return { feedId, ok: false, total: 0, newCount: 0, newIds: [], error: msg };
  }
}

/** pending な記事を順番にスコアリング (LLM CLI を一斉起動しないよう直列)。 */
export async function scorePendingArticles(db: Db, limit = 40): Promise<number> {
  const pending = listPendingArticles(db, limit);
  let scored = 0;
  for (const a of pending) {
    await scoreArticle(db, a.id);
    scored++;
  }
  return scored;
}

/** 閾値以上の新着を push 通知して notified を立てる。 */
export async function notifyTopArticles(db: Db): Promise<number> {
  const cfg = getRssConfig(db);
  if (!cfg.notify_enabled) return 0;
  const top = listNotifiableArticles(db, cfg.min_score_notify, 5);
  if (top.length === 0) return 0;

  const body = top.slice(0, 3).map(a => `・${a.title.slice(0, 50)}`).join('\n')
    + (top.length > 3 ? `\n…他 ${top.length - 3} 件` : '');
  await sendPushToAll(db, {
    title: '📡 あなた好みの記事が見つかりました',
    body,
    tag: 'memoria-rss-discover',
    url: '/?tab=rss',
  }).catch((e: unknown) => {
    console.error('[rss] push failed:', e instanceof Error ? e.message : String(e));
  });
  for (const a of top) markArticleNotified(db, a.id);
  return top.length;
}

let pollInFlight = false;

export interface PollAllResult {
  feeds: number;
  newArticles: number;
  scored: number;
  notified: number;
  skipped?: boolean;
}

/** 全有効フィードを取得 → 自動スコアリング → 通知。 多重起動はスキップ。 */
export async function pollAllFeeds(db: Db, opts: { score?: boolean } = {}): Promise<PollAllResult> {
  if (pollInFlight) return { feeds: 0, newArticles: 0, scored: 0, notified: 0, skipped: true };
  pollInFlight = true;
  try {
    const cfg = getRssConfig(db);
    const feeds = listEnabledFeeds(db);
    let newArticles = 0;
    for (const f of feeds) {
      const r = await pollFeed(db, f.id);
      newArticles += r.newCount;
    }
    let scored = 0;
    const shouldScore = opts.score ?? cfg.auto_score;
    if (shouldScore && newArticles > 0) {
      scored = await scorePendingArticles(db);
    }
    const notified = await notifyTopArticles(db);
    return { feeds: feeds.length, newArticles, scored, notified };
  } finally {
    pollInFlight = false;
  }
}
