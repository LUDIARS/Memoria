// Shared background job queues for the Memoria server.
//
// すべての claude / OpenAI / fetch を伴う処理は FIFO キューに乗せて
// 直列実行する (LLM 並列実行で rate limit を踏んだり、 ローカル CPU で
// 同時に何本も走らせたりしないため)。
//
// この module は queue インスタンス本体と、 各 queue にタスクを積む
// enqueueXxx ヘルパを返す factory を提供する。 caller (index.ts と
// 各 router) は makeQueues({ db, htmlDir, mealDir }) を 1 回呼んで、
// 必要な enqueue 関数 + queue snapshot 用の参照を受け取る。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { FifoQueue } from '../queue.js';
import {
  getBookmark, setSummary,
  getMeal, updateMeal,
  insertDomainPending, getDomainCatalog, setDomainCatalog, deleteDomainCatalog,
  insertPageMetadataPending, getPageMetadata, setPageMetadata, deletePageMetadata,
  setDigPreview, setDigResult, setDigRawResults,
  setWordCloudResult,
  upsertDiary, getDiary, getAppSettings,
  digThemeContext,
  upsertWeekly, listDiariesInRange,
  getDiarySettings,
  countBookmarksInRange, countVisitEventsInRange, countActivityEventsInRange,
  insertApplicationPending, getApplication, setApplication,
} from '../db.js';
import { summarizeWithClaude } from '../claude.js';
import { classifyDomain, shouldSkipDomain } from '../domain-catalog.js';
import { classifyApplication } from '../app-catalog.js';
import { fetchPageMetadata } from '../page-metadata.js';
import { extractWordCloud } from '../wordcloud.js';
import { analyzeMealPhoto, estimateCaloriesFromName } from '../meals.js';
import { runDig, runDigPreview } from '../dig.js';
import { runDigRawSerp } from '../dig-serp.js';
import {
  aggregateDay,
  fetchGithubActivity, fetchGithubRange,
  generateWorkContent, generateHighlights, generateWeekly,
  summarizeGithubByRepo,
  weekRangeFor, weekOfMonth,
} from '../diary.js';
import { sendPushToAll } from '../push.js';
import type { GithubByRepo, AggregatedDay } from '../diary.js';
import {
  getLatestSnapshotForDate, rowToForecast, describeCode, type Forecast,
} from './weather.js';

type Db = BetterSqlite3.Database;

// ── push 通知の batch 化 (ブクマ要約完了) ───────────────────────────────
//
// 一度に 10〜30 件まとめて summarize する運用が多いので、 個別通知すると
// 端末側がスパムになる。 5 件 or 5 分でまとめて 1 回。
interface PushBatchState {
  items: { id: number; title: string }[];
  timer: NodeJS.Timeout | null;
}

const BOOKMARK_PUSH_BATCH_SIZE = 5;
const BOOKMARK_PUSH_DEBOUNCE_MS = 5 * 60_000;

function makeBookmarkPusher(db: Db) {
  const state: PushBatchState = { items: [], timer: null };

  function flush(): void {
    if (state.items.length === 0) return;
    const items = state.items;
    state.items = [];
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const titleLines = items.slice(0, 5).map((it) => `・${(it.title || '').slice(0, 60)}`).join('\n');
    const more = items.length > 5 ? `\n…他 ${items.length - 5} 件` : '';
    sendPushToAll(db, {
      title: `📚 AI 要約完了 (${items.length} 件)`,
      body: titleLines + more,
      url: '/?tab=bookmarks',
      tag: 'memoria-bookmark-summary',
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[push] bookmark batch failed: ${msg}`);
    });
  }

  function notify(id: number, title: string | null | undefined): void {
    state.items.push({ id, title: title || '(untitled)' });
    if (state.items.length >= BOOKMARK_PUSH_BATCH_SIZE) {
      flush();
      return;
    }
    if (!state.timer) {
      state.timer = setTimeout(flush, BOOKMARK_PUSH_DEBOUNCE_MS);
    }
  }

  return { notify, flush };
}

// ── meal additions JSON helpers (queue 内で使う) ─────────────────────────
function parseMealAdditionsJson(json: string | null): { name: string; calories: number | null; added_at: string }[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr as { name: string; calories: number | null; added_at: string }[] : [];
  } catch {
    return [];
  }
}

// ── public API ──────────────────────────────────────────────────────────

export interface QueuesDeps {
  db: Db;
  htmlDir: string;
  mealDir: string;
  /** Vision 解析タイムアウト (ms)。 default 90s */
  mealVisionTimeoutMs?: number;
}

export interface QueueBundle {
  // Queue インスタンス (snapshot 用)
  summaryQueue: FifoQueue;
  cloudQueue: FifoQueue;
  domainCatalogQueue: FifoQueue;
  pageMetadataQueue: FifoQueue;
  mealVisionQueue: FifoQueue;
  digQueue: FifoQueue;
  diaryQueue: FifoQueue;
  weeklyQueue: FifoQueue;
  applicationCatalogQueue: FifoQueue;
  // タスク投入ヘルパ
  enqueueSummary: (id: number) => void;
  enqueueCloud: (id: number, args: { docs: string; label: string }) => void;
  enqueueDig: (id: number, query: string, opts?: { searchEngine?: string; theme?: string | null }) => void;
  enqueueDiary: (dateStr: string, opts?: { improve?: string }) => void;
  enqueueWeekly: (weekStart: string) => void;
  enqueueMealVision: (id: number) => void;
  enqueueCalorieEstimate: (mealId: number, additionIdx: number, foodName: string) => void;
  maybeQueuePageMetadata: (url: string) => void;
  maybeQueueDomain: (url: string) => void;
  maybeQueueApplication: (processName: string, recentTitles?: string[]) => void;
  /** ブクマ要約 push の batch flush (process exit 等の手動起動用) */
  flushBookmarkSummaryPush: () => void;
}

export function makeQueues(deps: QueuesDeps): QueueBundle {
  const { db, htmlDir, mealDir } = deps;
  const MEAL_VISION_TIMEOUT = deps.mealVisionTimeoutMs ?? 90_000;

  const summaryQueue = new FifoQueue();
  const cloudQueue = new FifoQueue();
  const domainCatalogQueue = new FifoQueue();
  const pageMetadataQueue = new FifoQueue();
  const mealVisionQueue = new FifoQueue();
  const digQueue = new FifoQueue();
  const applicationCatalogQueue = new FifoQueue();
  const diaryQueue = new FifoQueue();
  const weeklyQueue = new FifoQueue();

  const bookmarkPusher = makeBookmarkPusher(db);

  // ── bookmark summary ──────────────────────────────────────────────────
  function enqueueSummary(id: number): void {
    const b = getBookmark(db, id);
    summaryQueue.enqueue(async () => {
      const cur = getBookmark(db, id);
      if (!cur) throw new Error('bookmark not found');
      const htmlAbs = join(htmlDir, cur.html_path);
      if (!existsSync(htmlAbs)) {
        setSummary(db, id, { summary: null, categories: [], status: 'error', error: 'html file missing' });
        throw new Error('html file missing');
      }
      try {
        const html = readFileSync(htmlAbs, 'utf8');
        const { summary, categories } = await summarizeWithClaude({
          url: cur.url, title: cur.title, html,
        });
        setSummary(db, id, { summary, categories, status: 'done' });
        // batch 化された push 通知 (5 件 or 5 分)
        bookmarkPusher.notify(id, cur.title);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setSummary(db, id, { summary: null, categories: [], status: 'error', error: msg.slice(0, 500) });
        throw e;
      }
    }, {
      kind: 'summary',
      bookmarkId: id,
      title: b?.title ?? `id=${id}`,
      url: b?.url ?? '',
    });
  }

  // ── word cloud ────────────────────────────────────────────────────────
  function enqueueCloud(id: number, { docs, label }: { docs: string; label: string }): void {
    cloudQueue.enqueue(async () => {
      try {
        const result = await extractWordCloud({ label, docs });
        setWordCloudResult(db, id, { status: 'done', result });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setWordCloudResult(db, id, { status: 'error', error: msg.slice(0, 500) });
        throw e;
      }
    }, { kind: 'wordcloud', cloudId: id, title: label });
  }

  // ── page metadata (lazy) ──────────────────────────────────────────────
  function maybeQueuePageMetadata(url: string): void {
    let host: string;
    try { host = new URL(url).hostname.toLowerCase(); }
    catch { return; }
    if (shouldSkipDomain(host)) return;
    if (getPageMetadata(db, url)) return;
    insertPageMetadataPending(db, url);
    pageMetadataQueue.enqueue(async () => {
      const result = await fetchPageMetadata({ url });
      if ('skip' in result) {
        deletePageMetadata(db, url);
        return;
      }
      if ('dropRow' in result) {
        deletePageMetadata(db, url);
        console.log(`[page-meta] dropped ${url}: ${result.error}`);
        return;
      }
      if (!result.ok) {
        setPageMetadata(db, url, {
          title: result.title ?? null,
          meta_description: result.meta_description ?? null,
          og_title: result.og_title ?? null,
          og_description: result.og_description ?? null,
          og_image: result.og_image ?? null,
          og_type: result.og_type ?? null,
          content_type: result.content_type ?? null,
          http_status: result.http_status ?? null,
          status: 'error',
          error: result.error ?? 'unknown',
        });
        return;
      }
      setPageMetadata(db, url, {
        title: result.title,
        meta_description: result.meta_description,
        og_title: result.og_title,
        og_description: result.og_description,
        og_image: result.og_image,
        og_type: result.og_type,
        content_type: result.content_type,
        http_status: result.http_status,
        summary: result.summary,
        kind: result.kind,
        status: 'done',
        error: null,
      });
    }, { kind: 'page', url, title: url });
  }

  // ── domain catalog (lazy) ─────────────────────────────────────────────
  function extractDomainFromUrl(u: string): string | null {
    try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
  }

  function maybeQueueDomain(url: string): void {
    const domain = extractDomainFromUrl(url);
    if (!domain) return;
    if (shouldSkipDomain(domain)) return;
    if (getDomainCatalog(db, domain)) return;
    insertDomainPending(db, domain);
    domainCatalogQueue.enqueue(async () => {
      const result = await classifyDomain({ domain });
      if ('skip' in result) {
        deleteDomainCatalog(db, domain);
        return;
      }
      if ('dropRow' in result) {
        setDomainCatalog(db, domain, {
          title: null,
          description: null,
          status: 'error',
          error: result.error ?? 'fetch failed',
        });
        console.log(`[domain-catalog] fetch failed ${domain}: ${result.error}`);
        return;
      }
      if (!result.ok) {
        setDomainCatalog(db, domain, {
          title: result.title ?? null,
          description: result.metaDescription ?? null,
          status: 'error',
          error: result.error ?? 'unknown',
        });
        return;
      }
      setDomainCatalog(db, domain, {
        title: result.title,
        site_name: result.site_name,
        description: result.description,
        can_do: result.can_do,
        kind: result.kind,
        status: 'done',
        error: null,
      });
    }, { kind: 'domain', domain, title: domain });
  }

  // ── application catalog (= process_name → AI 分類) ────────────────────
  //
  // app_samples insert 時に「初めて見た process_name」 だったら enqueue。
  // 既に done / pending / error の row があれば skip。 短時間に同じ process が
  // 何度も sample されても 1 度しか走らない (= INSERT OR IGNORE で行を作って
  // 既存なら何もしない)。
  function maybeQueueApplication(processName: string, recentTitles?: string[]): void {
    const pn = (processName || '').trim();
    if (!pn) return;
    if (getApplication(db, pn)) return;
    insertApplicationPending(db, pn);
    applicationCatalogQueue.enqueue(async () => {
      try {
        const result = await classifyApplication({
          processName: pn,
          recentTitles,
          platform: process.platform,
        });
        setApplication(db, pn, {
          name: result.name,
          kind: result.kind,
          description: result.description,
          status: 'done',
          error: null,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setApplication(db, pn, { status: 'error', error: msg.slice(0, 500) });
      }
    }, { kind: 'application', processName: pn, title: pn });
  }

  // ── meal vision ───────────────────────────────────────────────────────
  function enqueueMealVision(id: number): void {
    mealVisionQueue.enqueue(async () => {
      const meal = getMeal(db, id);
      if (!meal) return;
      const fullPath = join(mealDir, meal.photo_path);
      if (!existsSync(fullPath)) {
        updateMeal(db, id, { ai_status: 'error', ai_error: 'photo file missing' });
        return;
      }
      try {
        const result = await Promise.race([
          analyzeMealPhoto(fullPath),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('vision timeout')), MEAL_VISION_TIMEOUT)),
        ]);
        if (!result) {
          updateMeal(db, id, { ai_status: 'error', ai_error: 'vision returned null' });
          return;
        }
        updateMeal(db, id, {
          description: result.description ?? null,
          calories: typeof result.calories === 'number' ? result.calories : null,
          items_json: result.items ? JSON.stringify(result.items) : null,
          nutrients_json: result.nutrients ? JSON.stringify(result.nutrients) : null,
          ai_status: 'done',
          ai_error: null,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        updateMeal(db, id, { ai_status: 'error', ai_error: msg.slice(0, 500) });
      }
    }, { kind: 'meal-vision', meal_id: id, title: `meal #${id}` });
  }

  // 食品名から標準カロリーを背景で推定する。 結果は対象 meal の additions[idx]
  // (idx == -1 のときは meal 本体の calories) に書き込む。 失敗は黙認 (UI に
  // 「— kcal」 のままを残す)。
  function enqueueCalorieEstimate(mealId: number, additionIdx: number, foodName: string): void {
    mealVisionQueue.enqueue(async () => {
      try {
        const r = await estimateCaloriesFromName(foodName);
        if (r.calories == null) return;
        const meal = getMeal(db, mealId);
        if (!meal) return;
        if (additionIdx === -1) {
          // meal 本体のカロリーを user_corrected_calories に書く (上書きしない)
          const patch: Record<string, unknown> = {};
          if (meal.user_corrected_calories == null && meal.calories == null) {
            patch.user_corrected_calories = r.calories;
          }
          // nutrients も未設定なら埋める
          if (!meal.nutrients_json && r.nutrients) {
            patch.nutrients_json = JSON.stringify(r.nutrients);
          }
          if (Object.keys(patch).length > 0) updateMeal(db, mealId, patch);
          return;
        }
        const additions = parseMealAdditionsJson(meal.additions_json);
        if (!additions[additionIdx]) return;
        // ユーザがその間に手動入力していたら上書きしない
        if (additions[additionIdx].calories != null) return;
        additions[additionIdx].calories = r.calories;
        updateMeal(db, mealId, { additions_json: JSON.stringify(additions) });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[meal#${mealId}] calorie estimate failed: ${msg}`);
      }
    }, { kind: 'meal-calorie', meal_id: mealId, title: `kcal: ${foodName.slice(0, 40)}` });
  }

  // ── dig (deep research) ──────────────────────────────────────────────
  function enqueueDig(id: number, query: string, opts: { searchEngine?: string; theme?: string | null } = {}): void {
    const searchEngine = opts.searchEngine ?? 'default';
    const theme = opts.theme ?? null;

    // Phase 0: raw SERP scrape — runs OUTSIDE the digQueue (no LLM, no
    // serialisation) so it lands within ~2 s regardless of whatever Claude
    // job is currently in flight. Failures are silent; the UI falls through
    // to the AI preview if this comes back empty.
    runDigRawSerp({ query, searchEngine })
      .then((raw) => { if (raw) setDigRawResults(db, id, raw); })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[dig#${id}] raw serp failed: ${msg}`);
      });

    digQueue.enqueue(async () => {
      // 同テーマの過去セッションから topics / sources / queries を集めて、
      // LLM プロンプトに 「これまで掘った領域」 として注入。 テーマ無しなら空。
      const themeCtx = theme ? digThemeContext(db, theme) : null;

      // Phase 1: SERP preview (fast — no page fetches). Persisted as soon as
      // it lands so the FE can render before the deep claude pass finishes.
      runDigPreview({ query, searchEngine })
        .then((preview) => setDigPreview(db, id, preview))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[dig#${id}] preview failed: ${msg}`);
        });
      // Phase 2: full deep analysis with WebFetch (existing behavior).
      try {
        const result = await runDig({ query, searchEngine, theme, themeContext: themeCtx });
        setDigResult(db, id, { status: 'done', result });
        // Dig 完了で push 通知 (登録済端末のみ)。 失敗は本体に影響させない。
        sendPushToAll(db, {
          title: `🔍 ディグ完了: ${query.slice(0, 40)}`,
          body: theme ? `テーマ: ${theme}` : 'AI 分析が出揃いました',
          url: `/?tab=dig&dig=${id}`,
          tag: `memoria-dig-${id}`,
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[push] dig#${id} notification failed: ${msg}`);
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setDigResult(db, id, { status: 'error', error: msg.slice(0, 500) });
        throw e;
      }
    }, { kind: 'dig', sessionId: id, title: theme ? `[${theme}] ${query}` : query, search_engine: searchEngine });
  }

  // ── diary ────────────────────────────────────────────────────────────
  interface DiaryStageCtx {
    metrics: AggregatedDay | null;
    github: Awaited<ReturnType<typeof fetchGithubActivity>> | null;
    notes: string;
    workContent: string;
    workMinutes?: number | null;
    githubByRepo: GithubByRepo | null;
    highlights: string;
    bookmarkSummary: { created: number; accessed: number; topDomains: string[] } | null;
    improve: string;
    globalMemo: string;
    failed: boolean;
  }

  function settingsAsObject() {
    const s = getDiarySettings(db);
    return {
      github_token: s.github_token || process.env.MEMORIA_GH_TOKEN || '',
      github_user: s.github_user || process.env.MEMORIA_GH_USER || '',
      github_repos: s.github_repos
        ? s.github_repos.split(',').map((x) => x.trim()).filter(Boolean)
        : [],
    };
  }

  function enqueueDiaryStages(dateStr: string, opts: { improve?: string } = {}): void {
    const ctx: DiaryStageCtx = {
      metrics: null,
      github: null,
      notes: '',
      workContent: '',
      githubByRepo: null,
      highlights: '',
      bookmarkSummary: null,
      improve: typeof opts.improve === 'string' ? opts.improve.trim() : '',
      globalMemo: '',
      failed: false,
    };

    function rememberFailure(stage: string, e: unknown): void {
      ctx.failed = true;
      const msg = e instanceof Error ? e.message : String(e);
      upsertDiary(db, {
        date: dateStr, status: 'error', metrics: ctx.metrics ?? aggregateDay(db, dateStr),
        githubCommits: ctx.github, error: `[${stage}] ${msg}`.slice(0, 500),
      });
    }

    // Stage 0: snapshot metrics + reset diary row to pending.
    diaryQueue.enqueue(async () => {
      if (ctx.failed) return;
      ctx.metrics = aggregateDay(db, dateStr, { listLimit: null });
      const prior = getDiary(db, dateStr);
      ctx.notes = prior?.notes || '';
      ctx.globalMemo = (getAppSettings(db)['diary.global_memo'] || '').trim();
      upsertDiary(db, { date: dateStr, status: 'pending', metrics: ctx.metrics, error: null });
    }, { kind: 'diary_prepare', date: dateStr, title: `📅 ${dateStr} 集計` });

    // Stage 1: GitHub fetch.
    diaryQueue.enqueue(async () => {
      if (ctx.failed) return;
      const settings = settingsAsObject();
      if (!settings.github_user) return;
      try {
        ctx.github = await fetchGithubActivity({
          token: settings.github_token,
          user: settings.github_user,
          repos: settings.github_repos,
          dateStr,
        });
      } catch (e: unknown) {
        rememberFailure('github', e);
        throw e;
      }
    }, { kind: 'diary_github', date: dateStr, title: `📥 ${dateStr} GitHub commits` });

    // Stage 2: 作業内容 (Sonnet by default).
    diaryQueue.enqueue(async () => {
      if (ctx.failed) return;
      if (!ctx.metrics) return;
      try {
        const work = await generateWorkContent({
          db, dateStr, metrics: ctx.metrics,
          globalMemo: ctx.globalMemo,
          improve: ctx.improve,
        });
        ctx.workContent = work.content;
        ctx.workMinutes = work.workMinutes;
        upsertDiary(db, {
          date: dateStr,
          workContent: ctx.workContent,
          workMinutes: ctx.workMinutes,
          metrics: ctx.metrics,
          githubCommits: ctx.github,
          status: 'pending',
          error: null,
        });
      } catch (e: unknown) {
        rememberFailure('work', e);
        throw e;
      }
    }, { kind: 'diary_work', date: dateStr, title: `📝 ${dateStr} 作業内容 (Sonnet)` });

    // Stage 3: ハイライト (Opus 1M by default).
    diaryQueue.enqueue(async () => {
      if (ctx.failed) return;
      if (!ctx.metrics) return;
      try {
        ctx.githubByRepo = summarizeGithubByRepo(ctx.github);
        const metrics = ctx.metrics;
        const created = metrics.bookmarks?.created ?? [];
        const accessed = metrics.bookmarks?.accessed ?? [];
        const domSet = new Set<string>();
        for (const b of [...created, ...accessed]) {
          try { domSet.add(new URL(b.url).hostname); } catch { /* ignore */ }
        }
        ctx.bookmarkSummary = {
          created: created.length,
          accessed: accessed.length,
          topDomains: [...domSet].slice(0, 8),
        };
        const digs = metrics.digs ?? [];
        ctx.highlights = await generateHighlights({
          dateStr,
          workContent: ctx.workContent,
          githubByRepo: ctx.githubByRepo,
          bookmarkSummary: ctx.bookmarkSummary,
          digs, notes: ctx.notes, metrics,
          globalMemo: ctx.globalMemo,
          improve: ctx.improve,
        });
        const summary = composeDiarySummary({
          weatherBlock: buildWeatherBlock(db, dateStr),
          workContent: ctx.workContent,
          githubByRepo: ctx.githubByRepo,
          highlights: ctx.highlights,
          digs,
          activity: ctx.metrics?.activity ?? null,
          apps: ctx.metrics?.apps ?? null,
          games: ctx.metrics?.games ?? null,
        });
        upsertDiary(db, {
          date: dateStr,
          summary,
          workContent: ctx.workContent,
          workMinutes: ctx.workMinutes,
          highlights: ctx.highlights,
          metrics: ctx.metrics,
          githubCommits: ctx.github,
          status: 'done',
          error: null,
        });
        // 日記が完成したら登録済端末に push 通知。 失敗しても本体には影響させない。
        sendPushToAll(db, {
          title: `📝 ${dateStr} の日記が完成しました`,
          body: ctx.highlights ? ctx.highlights.split('\n').slice(0, 2).join(' ').slice(0, 140) : '作業内容とハイライトが揃いました',
          url: `/?tab=diary&date=${encodeURIComponent(dateStr)}`,
          tag: `memoria-diary-${dateStr}`,
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[push] diary notification failed: ${msg}`);
        });
      } catch (e: unknown) {
        rememberFailure('highlights', e);
        throw e;
      }
    }, { kind: 'diary_highlights', date: dateStr, title: `✨ ${dateStr} ハイライト (Opus 1M)` });
  }

  function enqueueDiary(dateStr: string, opts: { improve?: string } = {}): void {
    enqueueDiaryStages(dateStr, opts);
  }

  // ── weekly ───────────────────────────────────────────────────────────
  function enqueueWeekly(weekStart: string): void {
    weeklyQueue.enqueue(async () => {
      await runWeeklyGenerationLocal(weekStart);
    }, { kind: 'weekly', weekStart, title: weekStart });
  }

  async function runWeeklyGenerationLocal(weekStart: string): Promise<void> {
    const range = weekRangeFor(weekStart);
    const { weekInMonth, month } = weekOfMonth(range.start);
    upsertWeekly(db, {
      weekStart: range.start, weekEnd: range.end, month, weekInMonth,
      status: 'pending', error: null,
    });

    const dailyDiaries = listDiariesInRange(db, { start: range.start, end: range.end });

    const settings = settingsAsObject();
    let githubByRepo: GithubByRepo = { repos: [], total: 0 };
    if (settings.github_user && settings.github_repos.length > 0) {
      const since = `${range.start}T00:00:00Z`;
      const until = `${range.end}T23:59:59Z`;
      const fetched = await fetchGithubRange({
        token: settings.github_token, user: settings.github_user,
        repos: settings.github_repos, since, until,
      });
      githubByRepo = summarizeGithubByRepo(fetched);
    }

    // 週次定量メトリクス: ローカル DB から count + diary work_minutes 合計
    const workMinutesTotal = dailyDiaries.reduce(
      (acc, d) => acc + (typeof d.work_minutes === 'number' && d.work_minutes > 0 ? d.work_minutes : 0),
      0,
    );
    const metrics = {
      work_minutes: workMinutesTotal,
      bookmarks: countBookmarksInRange(db, range),
      visit_events: countVisitEventsInRange(db, range),
      github_commits: githubByRepo.total,
      git_commits_local: countActivityEventsInRange(db, 'git_commit', range),
      claude_code_prompts: countActivityEventsInRange(db, 'claude_code_prompt', range),
    };

    let summary: string;
    try {
      summary = await generateWeekly({
        weekStart: range.start, weekEnd: range.end,
        dailyDiaries, githubByRepo, metrics,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      upsertWeekly(db, {
        weekStart: range.start, status: 'error', githubSummary: githubByRepo,
        error: msg.slice(0, 500),
      });
      throw e;
    }

    upsertWeekly(db, {
      weekStart: range.start, summary,
      githubSummary: githubByRepo,
      status: 'done', error: null,
    });
  }

  return {
    summaryQueue,
    cloudQueue,
    domainCatalogQueue,
    pageMetadataQueue,
    mealVisionQueue,
    digQueue,
    diaryQueue,
    weeklyQueue,
    applicationCatalogQueue,
    enqueueSummary,
    enqueueCloud,
    enqueueDig,
    enqueueDiary,
    enqueueWeekly,
    enqueueMealVision,
    enqueueCalorieEstimate,
    maybeQueuePageMetadata,
    maybeQueueDomain,
    maybeQueueApplication,
    flushBookmarkSummaryPush: bookmarkPusher.flush,
  };
}

// Mirror of `composeSummary` from diary.js — extracted here so we can run
// the highlights stage independently in the queue chain.
interface ComposeSummaryArgs {
  /** その日の天気サマリーブロック (markdown 1 段落)。 weather snapshot が
   *  無い date では undefined (= 出さない)。 */
  weatherBlock?: string;
  workContent: string;
  githubByRepo: GithubByRepo | null;
  highlights: string;
  digs: { query: string; source_count: number; summary?: string | null }[] | null;
  activity: {
    total: number;
    kinds?: Partial<Record<string, number>>;
    items?: { occurred_at?: string | null; kind: string; source?: string | null; content?: string | null }[];
  } | null;
  apps?: {
    total_minutes: number;
    active_minutes: number;
    by_kind: { kind: string; minutes: number; active_minutes: number }[];
    top: { display_name: string; kind: string | null; minutes: number; active_minutes: number }[];
  } | null;
  games?: {
    total_minutes: number;
    items: { name: string; minutes: number; first_at: string; last_at: string }[];
  } | null;
}

/** 「## 天気」 セクションを 1 ブロック返す。 weather snapshot が無ければ '' 。
 *  date は YYYY-MM-DD (local)。 hourly が空でも daily だけで線形に組む。 */
function buildWeatherBlock(db: BetterSqlite3.Database, date: string): string {
  const row = getLatestSnapshotForDate(db, date);
  if (!row) return '';
  const f: Forecast = rowToForecast(row);
  // daily の該当 index (Open-Meteo は forecast_days=2 で取るので 1 行目が today)
  const idx = f.daily.time.indexOf(date);
  if (idx < 0) return '';
  const code = f.daily.weather_code[idx] ?? 0;
  const desc = describeCode(code);
  const tMax = f.daily.temperature_max[idx];
  const tMin = f.daily.temperature_min[idx];
  const precip = f.daily.precipitation_sum[idx];
  const pieces: string[] = [`${desc.icon} ${desc.label}`];
  if (Number.isFinite(tMax) && Number.isFinite(tMin)) {
    pieces.push(`最高 ${Math.round(tMax)}℃ / 最低 ${Math.round(tMin)}℃`);
  }
  if (Number.isFinite(precip) && precip > 0) {
    pieces.push(`降水 ${precip.toFixed(1)}mm`);
  }
  // hourly があれば雨だった時間帯を 1 行で添える (= 「12:00〜15:00 雨」)
  const rainHours = collectRainHours(f, date);
  const lines = [pieces.join(' / ')];
  if (rainHours) lines.push(rainHours);
  return `## 天気\n${lines.join('\n')}`;
}

function collectRainHours(f: Forecast, date: string): string {
  if (!f.hourly?.time?.length) return '';
  const ranges: { start: string; end: string }[] = [];
  let curStart: string | null = null;
  let curEnd: string | null = null;
  for (let i = 0; i < f.hourly.time.length; i++) {
    const t = f.hourly.time[i];
    if (!t.startsWith(date)) continue;
    const precip = f.hourly.precipitation[i] ?? 0;
    const code = f.hourly.weather_code[i] ?? 0;
    const rain = precip >= 0.5 || (code >= 51 && code <= 99 && code < 71);
    if (rain) {
      if (!curStart) curStart = t.slice(11, 16);
      curEnd = t.slice(11, 16);
    } else if (curStart && curEnd) {
      ranges.push({ start: curStart, end: curEnd });
      curStart = null; curEnd = null;
    }
  }
  if (curStart && curEnd) ranges.push({ start: curStart, end: curEnd });
  if (ranges.length === 0) return '';
  return '雨: ' + ranges.map((r) => r.start === r.end ? r.start : `${r.start}〜${r.end}`).join(', ');
}

function composeDiarySummary({ weatherBlock, workContent, githubByRepo, highlights, digs, activity, apps, games }: ComposeSummaryArgs): string {
  const parts: string[] = [];
  if (weatherBlock) parts.push(weatherBlock);
  if (workContent) parts.push(`## 作業内容\n${workContent.trim()}`);
  if (digs && digs.length > 0) {
    const digLines = digs.map((d) => {
      const head = `- 「${d.query}」 (${d.source_count} 件のソース)`;
      return d.summary ? `${head}\n  ${d.summary.slice(0, 250)}` : head;
    }).join('\n');
    parts.push(`## ディグ調査\n${digLines}`);
  }
  if (githubByRepo?.repos?.length) {
    const repoLines = githubByRepo.repos.map((r) => `- ${r.repo}: ${r.count} commits`).join('\n');
    parts.push(`## GitHub commits (${githubByRepo.total} 件)\n${repoLines}`);
  }
  if (activity && activity.total > 0) {
    const countParts: string[] = [];
    if (activity.kinds?.git_commit) countParts.push(`git commit ${activity.kinds.git_commit} 件`);
    if (activity.kinds?.claude_code_prompt) countParts.push(`Claude Code 指示 ${activity.kinds.claude_code_prompt} 件`);
    const head = countParts.length > 0 ? countParts.join(' / ') : `${activity.total} 件`;
    const items = (activity.items ?? []).slice(0, 10).map((it) => {
      const t = (it.occurred_at ?? '').slice(11, 16);
      const tag = it.kind === 'git_commit' ? 'git'
        : it.kind === 'claude_code_prompt' ? 'cc' : it.kind;
      const src = it.source ? ` ${it.source}:` : '';
      const content = (it.content ?? '').replace(/\s+/g, ' ').slice(0, 120);
      return `- ${t} [${tag}]${src} ${content}`.trim();
    });
    const tail = (activity.items ?? []).length > 10
      ? `\n- … ほか ${(activity.items ?? []).length - 10} 件`
      : '';
    parts.push(`## 開発活動\n合計: ${head}\n${items.join('\n')}${tail}`);
  }
  if (apps && apps.top.length > 0) {
    const fmt = (m: number) => m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`.replace(' 0m', '');
    const kindStr = (apps.by_kind || [])
      .filter((k) => k.minutes >= 1)
      .slice(0, 6)
      .map((k) => `${k.kind} ${fmt(k.minutes)}`)
      .join(' / ');
    const topLines = apps.top.slice(0, 8).map((it) =>
      `- ${it.display_name} (${it.kind || '?'}): ${fmt(it.minutes)}`
    );
    parts.push(`## アプリ使用 (${fmt(apps.total_minutes)})${kindStr ? `\n${kindStr}` : ''}\n${topLines.join('\n')}`);
  }
  if (games && games.items.length > 0) {
    const fmt = (m: number) => m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`.replace(' 0m', '');
    const lines = games.items.map((g) => {
      const startHH = g.first_at?.slice(11, 16);
      const endHH = g.last_at?.slice(11, 16);
      const span = (startHH && endHH && startHH !== endHH) ? ` (${startHH}〜${endHH})` : '';
      return `- 🎮 ${g.name}: ${fmt(g.minutes)}${span}`;
    });
    parts.push(`## ゲームプレイ (${fmt(games.total_minutes)})\n${lines.join('\n')}`);
  }
  if (highlights) parts.push(`## ハイライト\n${highlights.trim()}`);
  return parts.join('\n\n');
}
