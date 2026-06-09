// RSS ドメインの DB アクセス層。 SQL は全てここに閉じ込め、
// route / poll / score 層は型付き関数だけを使う。

import type BetterSqlite3 from 'better-sqlite3';
import type {
  RssFeedRow, RssArticleRow, RssInterestRow, RssDigestRow, RssFeedKind, RssAiStatus, ParsedArticle,
} from './types.js';

type Db = BetterSqlite3.Database;

// ── feeds ──────────────────────────────────────────────────────────────────

export interface FeedWithStats extends RssFeedRow {
  article_count: number;
  unread_count: number;
}

export function listFeeds(db: Db): FeedWithStats[] {
  return db.prepare(`
    SELECT f.*,
           (SELECT COUNT(*) FROM rss_articles a WHERE a.feed_id = f.id) AS article_count,
           (SELECT COUNT(*) FROM rss_articles a WHERE a.feed_id = f.id AND a.read_at IS NULL) AS unread_count
    FROM rss_feeds f
    ORDER BY f.created_at DESC
  `).all() as FeedWithStats[];
}

export function getFeed(db: Db, id: number): RssFeedRow | undefined {
  return db.prepare(`SELECT * FROM rss_feeds WHERE id = ?`).get(id) as RssFeedRow | undefined;
}

export function getFeedByUrl(db: Db, url: string): RssFeedRow | undefined {
  return db.prepare(`SELECT * FROM rss_feeds WHERE url = ?`).get(url) as RssFeedRow | undefined;
}

export function listEnabledFeeds(db: Db): RssFeedRow[] {
  return db.prepare(`SELECT * FROM rss_feeds WHERE enabled = 1 ORDER BY id`).all() as RssFeedRow[];
}

export interface InsertFeedInput {
  url: string;
  kind: RssFeedKind;
  title?: string | null;
  category?: string | null;
}

export function insertFeed(db: Db, input: InsertFeedInput): number {
  const info = db.prepare(`
    INSERT INTO rss_feeds (url, kind, title, category)
    VALUES (?, ?, ?, ?)
  `).run(input.url, input.kind, input.title ?? null, input.category ?? null);
  return Number(info.lastInsertRowid);
}

export interface UpdateFeedPatch {
  enabled?: boolean;
  category?: string | null;
  title?: string | null;
}

export function updateFeed(db: Db, id: number, patch: UpdateFeedPatch): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); vals.push(patch.enabled ? 1 : 0); }
  if (patch.category !== undefined) { sets.push('category = ?'); vals.push(patch.category); }
  if (patch.title !== undefined) { sets.push('title = ?'); vals.push(patch.title); }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE rss_feeds SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export interface FeedFetchResult {
  status: 'ok' | 'error';
  error?: string | null;
  title?: string | null;
  siteUrl?: string | null;
  description?: string | null;
}

export function markFeedFetched(db: Db, id: number, r: FeedFetchResult): void {
  db.prepare(`
    UPDATE rss_feeds
    SET last_fetched_at = datetime('now'),
        last_status = ?,
        last_error = ?,
        title = COALESCE(?, title),
        site_url = COALESCE(?, site_url),
        description = COALESCE(?, description)
    WHERE id = ?
  `).run(r.status, r.error ?? null, r.title ?? null, r.siteUrl ?? null, r.description ?? null, id);
}

export function deleteFeed(db: Db, id: number): boolean {
  const info = db.prepare(`DELETE FROM rss_feeds WHERE id = ?`).run(id);
  return info.changes > 0;
}

// ── articles ────────────────────────────────────────────────────────────────

/** 1 記事を upsert。 新規挿入なら { id, isNew:true }、 既存なら更新せず isNew:false。 */
export function upsertArticle(db: Db, feedId: number, a: ParsedArticle): { id: number; isNew: boolean } {
  const existing = db.prepare(`SELECT id FROM rss_articles WHERE feed_id = ? AND guid = ?`)
    .get(feedId, a.guid) as { id: number } | undefined;
  if (existing) return { id: existing.id, isNew: false };
  const info = db.prepare(`
    INSERT INTO rss_articles
      (feed_id, guid, url, title, summary, author, image_url, meta_json, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    feedId, a.guid, a.url, a.title, a.summary, a.author, a.imageUrl,
    a.meta ? JSON.stringify(a.meta) : null, a.publishedAt,
  );
  return { id: Number(info.lastInsertRowid), isNew: true };
}

export interface ListArticlesOptions {
  feedId?: number | null;
  category?: string | null;
  kind?: RssFeedKind | null;
  minScore?: number | null;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  sort?: 'score' | 'published';
  limit?: number;
  offset?: number;
}

export interface ArticleWithFeed extends RssArticleRow {
  feed_title: string | null;
  feed_kind: RssFeedKind;
  feed_category: string | null;
}

export function listArticles(db: Db, opts: ListArticlesOptions = {}): ArticleWithFeed[] {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.feedId != null) { where.push('a.feed_id = ?'); vals.push(opts.feedId); }
  if (opts.category) { where.push('f.category = ?'); vals.push(opts.category); }
  if (opts.kind) { where.push('f.kind = ?'); vals.push(opts.kind); }
  if (opts.minScore != null) { where.push('a.ai_score >= ?'); vals.push(opts.minScore); }
  if (opts.unreadOnly) where.push('a.read_at IS NULL');
  if (opts.starredOnly) where.push('a.starred = 1');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // score ソート時は未スコア (NULL) を末尾に。 published は公開日時降順。
  const orderSql = opts.sort === 'score'
    ? `ORDER BY (a.ai_score IS NULL), a.ai_score DESC, a.published_at DESC`
    : `ORDER BY a.published_at DESC, a.id DESC`;
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  vals.push(limit, offset);
  return db.prepare(`
    SELECT a.*, f.title AS feed_title, f.kind AS feed_kind, f.category AS feed_category
    FROM rss_articles a
    JOIN rss_feeds f ON f.id = a.feed_id
    ${whereSql}
    ${orderSql}
    LIMIT ? OFFSET ?
  `).all(...vals) as ArticleWithFeed[];
}

export function getArticle(db: Db, id: number): RssArticleRow | undefined {
  return db.prepare(`SELECT * FROM rss_articles WHERE id = ?`).get(id) as RssArticleRow | undefined;
}

export function setArticleRead(db: Db, id: number, read: boolean): void {
  db.prepare(`UPDATE rss_articles SET read_at = ? WHERE id = ?`)
    .run(read ? new Date().toISOString() : null, id);
}

export function setArticleStar(db: Db, id: number, starred: boolean): void {
  db.prepare(`UPDATE rss_articles SET starred = ? WHERE id = ?`).run(starred ? 1 : 0, id);
}

export function markArticleNotified(db: Db, id: number): void {
  db.prepare(`UPDATE rss_articles SET notified_at = datetime('now') WHERE id = ?`).run(id);
}

export function listPendingArticles(db: Db, limit = 30): RssArticleRow[] {
  return db.prepare(`
    SELECT * FROM rss_articles WHERE ai_status = 'pending'
    ORDER BY published_at DESC, id DESC LIMIT ?
  `).all(limit) as RssArticleRow[];
}

/** スコア通知対象: 閾値以上 / 未通知 / 既読でない。 push 用。 */
export function listNotifiableArticles(db: Db, minScore: number, limit = 5): ArticleWithFeed[] {
  return db.prepare(`
    SELECT a.*, f.title AS feed_title, f.kind AS feed_kind, f.category AS feed_category
    FROM rss_articles a
    JOIN rss_feeds f ON f.id = a.feed_id
    WHERE a.ai_status = 'done' AND a.ai_score >= ?
      AND a.notified_at IS NULL AND a.read_at IS NULL
    ORDER BY a.ai_score DESC LIMIT ?
  `).all(minScore, limit) as ArticleWithFeed[];
}

export interface ScorePatch {
  score: number | null;
  reason: string | null;
  matched: string | null;
  status: RssAiStatus;
}

export function setArticleScore(db: Db, id: number, p: ScorePatch): void {
  db.prepare(`
    UPDATE rss_articles
    SET ai_score = ?, ai_reason = ?, ai_matched = ?, ai_status = ?
    WHERE id = ?
  `).run(p.score, p.reason, p.matched, p.status, id);
}

export function setArticleSummary(db: Db, id: number, summary: string): void {
  db.prepare(`UPDATE rss_articles SET ai_summary = ? WHERE id = ?`).run(summary, id);
}

/** 自動要約の対象: スコア閾値以上で未要約の記事 (新しい順)。 */
export function listUnsummarizedTop(db: Db, minScore: number, limit = 5): RssArticleRow[] {
  return db.prepare(`
    SELECT * FROM rss_articles
    WHERE ai_summary IS NULL AND ai_score >= ?
    ORDER BY ai_score DESC, published_at DESC LIMIT ?
  `).all(minScore, limit) as RssArticleRow[];
}

/** トレンド検知記事: トレンド系フィード (Google トレンド / はてブ) の直近上位。 */
export function listTrendingArticles(db: Db, hours = 24, limit = 8): ArticleWithFeed[] {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  return db.prepare(`
    SELECT a.*, f.title AS feed_title, f.kind AS feed_kind, f.category AS feed_category
    FROM rss_articles a
    JOIN rss_feeds f ON f.id = a.feed_id
    WHERE f.kind IN ('google_trends', 'hatena')
      AND COALESCE(a.published_at, a.fetched_at) >= ?
    ORDER BY (a.ai_score IS NULL), a.ai_score DESC, a.published_at DESC, a.id DESC
    LIMIT ?
  `).all(since, limit) as ArticleWithFeed[];
}

/** 直近 N 分に取り込んだ記事 (fetched_at ベース、 新しい順)。 ブリーフィングの「直近◯分のニュース」 用。 */
export function listArticlesSinceMinutes(db: Db, minutes: number, limit = 8): ArticleWithFeed[] {
  const m = Math.max(1, Math.round(minutes));
  return db.prepare(`
    SELECT a.*, f.title AS feed_title, f.kind AS feed_kind, f.category AS feed_category
    FROM rss_articles a
    JOIN rss_feeds f ON f.id = a.feed_id
    WHERE a.fetched_at >= datetime('now', ?)
    ORDER BY a.fetched_at DESC, a.id DESC
    LIMIT ?
  `).all(`-${m} minutes`, Math.min(50, Math.max(1, limit))) as ArticleWithFeed[];
}

/** ダイジェスト素材: 直近 hours 時間の上位記事 (スコア優先、 無ければ新着)。 */
export function listRecentTopArticles(db: Db, hours = 36, limit = 15): ArticleWithFeed[] {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  return db.prepare(`
    SELECT a.*, f.title AS feed_title, f.kind AS feed_kind, f.category AS feed_category
    FROM rss_articles a
    JOIN rss_feeds f ON f.id = a.feed_id
    WHERE COALESCE(a.published_at, a.fetched_at) >= ?
    ORDER BY (a.ai_score IS NULL), a.ai_score DESC, a.published_at DESC
    LIMIT ?
  `).all(since, limit) as ArticleWithFeed[];
}

/** 興味テーマを変えたら全記事を再スコア対象に戻す。 */
export function resetAllScores(db: Db): void {
  db.prepare(`UPDATE rss_articles SET ai_status = 'pending' WHERE ai_status IN ('done', 'skip')`).run();
}

// ── digests (おすすめダイジェスト) ───────────────────────────────────────────

export function getDigest(db: Db, date: string): RssDigestRow | undefined {
  return db.prepare(`SELECT * FROM rss_digests WHERE date = ?`).get(date) as RssDigestRow | undefined;
}

export function getLatestDigest(db: Db): RssDigestRow | undefined {
  return db.prepare(`SELECT * FROM rss_digests ORDER BY date DESC LIMIT 1`).get() as RssDigestRow | undefined;
}

export function upsertDigest(db: Db, date: string, content: string, articleIds: number[]): void {
  db.prepare(`
    INSERT INTO rss_digests (date, content, article_ids, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(date) DO UPDATE SET
      content = excluded.content,
      article_ids = excluded.article_ids,
      created_at = excluded.created_at
  `).run(date, content, JSON.stringify(articleIds));
}

// ── interests (AI Feeds テーマ) ──────────────────────────────────────────────

export function listInterests(db: Db): RssInterestRow[] {
  return db.prepare(`SELECT * FROM rss_interests ORDER BY created_at DESC`).all() as RssInterestRow[];
}

export function listEnabledInterests(db: Db): RssInterestRow[] {
  return db.prepare(`SELECT * FROM rss_interests WHERE enabled = 1 ORDER BY id`).all() as RssInterestRow[];
}

export function insertInterest(db: Db, input: { label: string; prompt: string; weight?: number }): number {
  const info = db.prepare(`
    INSERT INTO rss_interests (label, prompt, weight) VALUES (?, ?, ?)
  `).run(input.label, input.prompt, input.weight ?? 1.0);
  return Number(info.lastInsertRowid);
}

export interface UpdateInterestPatch {
  label?: string;
  prompt?: string;
  weight?: number;
  enabled?: boolean;
}

export function updateInterest(db: Db, id: number, patch: UpdateInterestPatch): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.label !== undefined) { sets.push('label = ?'); vals.push(patch.label); }
  if (patch.prompt !== undefined) { sets.push('prompt = ?'); vals.push(patch.prompt); }
  if (patch.weight !== undefined) { sets.push('weight = ?'); vals.push(patch.weight); }
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); vals.push(patch.enabled ? 1 : 0); }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE rss_interests SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function deleteInterest(db: Db, id: number): boolean {
  return db.prepare(`DELETE FROM rss_interests WHERE id = ?`).run(id).changes > 0;
}

// ── settings (app_settings の rss.* キーを直接読み書き) ────────────────────────

export interface RssConfig {
  enabled: boolean;
  poll_interval_minutes: number;
  auto_score: boolean;
  min_score_notify: number;
  notify_enabled: boolean;
  /** 取得時に高スコア新着を自動で AI 要約する (コスト増)。 */
  auto_summarize: boolean;
}

const DEFAULT_CONFIG: RssConfig = {
  enabled: true,
  poll_interval_minutes: 30,
  auto_score: true,
  min_score_notify: 0.75,
  notify_enabled: false,
  auto_summarize: false,
};

export function getRssConfig(db: Db): RssConfig {
  const rows = db.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'rss.%'`)
    .all() as { key: string; value: string | null }[];
  const m = new Map(rows.map(r => [r.key, r.value]));
  const bool = (k: string, d: boolean) => {
    const v = m.get(k);
    return v == null ? d : v === '1' || v === 'true';
  };
  const num = (k: string, d: number) => {
    const v = Number(m.get(k));
    return Number.isFinite(v) ? v : d;
  };
  return {
    enabled: bool('rss.enabled', DEFAULT_CONFIG.enabled),
    poll_interval_minutes: num('rss.poll_interval_minutes', DEFAULT_CONFIG.poll_interval_minutes),
    auto_score: bool('rss.auto_score', DEFAULT_CONFIG.auto_score),
    min_score_notify: num('rss.min_score_notify', DEFAULT_CONFIG.min_score_notify),
    notify_enabled: bool('rss.notify_enabled', DEFAULT_CONFIG.notify_enabled),
    auto_summarize: bool('rss.auto_summarize', DEFAULT_CONFIG.auto_summarize),
  };
}

export function setRssConfig(db: Db, patch: Partial<RssConfig>): void {
  const map: Record<string, string> = {};
  if (patch.enabled !== undefined) map['rss.enabled'] = patch.enabled ? '1' : '0';
  if (patch.poll_interval_minutes !== undefined) map['rss.poll_interval_minutes'] = String(Math.max(5, Math.round(patch.poll_interval_minutes)));
  if (patch.auto_score !== undefined) map['rss.auto_score'] = patch.auto_score ? '1' : '0';
  if (patch.min_score_notify !== undefined) map['rss.min_score_notify'] = String(Math.min(1, Math.max(0, patch.min_score_notify)));
  if (patch.notify_enabled !== undefined) map['rss.notify_enabled'] = patch.notify_enabled ? '1' : '0';
  if (patch.auto_summarize !== undefined) map['rss.auto_summarize'] = patch.auto_summarize ? '1' : '0';
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(map)) {
      db.prepare(`
        INSERT INTO app_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(k, v);
    }
  });
  tx();
}
