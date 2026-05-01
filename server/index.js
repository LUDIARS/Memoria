import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb,
  insertBookmark,
  setSummary,
  listBookmarks,
  countBookmarks,
  getBookmark,
  listAllCategories,
  updateMemoAndCategories,
  deleteBookmark,
  recordAccess,
  findBookmarkByUrl,
  listAccesses,
  insertImportedBookmark,
  upsertVisit,
  listUnsavedVisits,
  listSuggestedVisits,
  deleteVisit,
  trendsCategories,
  trendsCategoryDiff,
  trendsTimeline,
  trendsDomains,
  trendsWorkHours,
  trendsKeywords,
  trendsGpsWalking,
} from './db.js';
import { summarizeWithClaude, htmlToText } from './claude.js';
import { FifoQueue, ConcurrentPool } from './queue.js';
import { recommendationsFor, dismissRecommendation, clearDismissals } from './recommendations.js';
import { runDig, runDigPreview, listSearchEngines, deriveDigTheme } from './dig.js';
import { runDigRawSerp } from './dig-serp.js';
import {
  insertDigSession, setDigResult, setDigPreview, setDigRawResults, getDigSession, listDigSessions, deleteDigSession,
  listDigThemes, digThemeContext,
  digSessionsForDate,
  insertWordCloud, setWordCloudResult, getWordCloud, listWordClouds,
  getBookmarkWordCloud, recentBookmarkWordClouds, trendsVisitDomains,
  listDictionaryEntries, getDictionaryEntry, findDictionaryEntryByTerm,
  insertDictionaryEntry, updateDictionaryEntry, deleteDictionaryEntry,
  addDictionaryLink, removeDictionaryLink,
  insertVisitEvent, getDiary, listDiariesInRange, upsertDiary, updateDiaryNotes,
  deleteDiary, getDiarySettings, setDiarySettings,
  getWeekly, listWeeklyForMonth, upsertWeekly, deleteWeekly,
  getDomainCatalog, listDomainCatalog, listDomainCatalogWithCounts, getDomainCatalogMap,
  insertDomainPending, setDomainCatalog, deleteDomainCatalog,
  updateDomainCatalogUser,
  getPageMetadata, getPageMetadataMap, insertPageMetadataPending,
  setPageMetadata, deletePageMetadata,
} from './db.js';
import { classifyDomain, shouldSkipDomain } from './domain-catalog.js';
import { fetchPageMetadata } from './page-metadata.js';
import { extractWordCloud, validateWordRelevance } from './wordcloud.js';
import { startUptimeTracking, readHeartbeat, DOWNTIME_THRESHOLD_MS } from './local/uptime.js';
import { listServerEvents, listServerEventsForDate } from './db.js';
import {
  aggregateDay, fetchGithubActivity, fetchGithubRange,
  generateDiary, generateWorkContent, generateHighlights,
  generateWeekly, summarizeGithubByRepo,
  bookmarksForDate,
  formatLocalDate, yesterdayLocal, weekRangeFor, weekOfMonth, pingGithub,
} from './diary.js';
import {
  TASKS as LLM_TASKS, PROVIDERS as LLM_PROVIDERS,
  getLlmConfig, loadLlmConfigFromSettings, settingsPatchFromConfig,
} from './llm.js';
import { getAppSettings, setAppSettings } from './db.js';
import {
  markBookmarkShared, markDigShared, markDictionaryShared,
  setBookmarkOwner, setDigOwner, setDictionaryOwner,
} from './db.js';
import {
  insertGpsLocation, listGpsLocationsInRange, listGpsLocationDays,
  listGpsLocationsForDate, deleteGpsLocationsOlderThan,
} from './db.js';
import { listPushSubscriptions, deletePushSubscription } from './db.js';
import {
  insertMeal, getMeal, listMeals, countMeals, updateMeal, deleteMeal, listPendingMeals,
} from './db.js';
import {
  ensureUserStopwordsTable, listUserStopwords, addUserStopword, removeUserStopword,
} from './db.js';
import { initWebPush, getVapidPublicKey, saveSubscription, sendPushToAll } from './push.js';
import {
  extractPhotoMeta, resolveMealLocation, analyzeMealPhoto, estimateCaloriesFromName,
} from './meals.js';
import {
  readMultiState, isConnected,
  readMultiServers, persistServers, upsertServer, removeServer,
  saveServerSession, clearServerSession, setActive, listConnectedActive,
  fetchMe, shareBookmark, shareDig, shareDictionary,
  multiFetch,
} from './local/multi-client.js';

// ---- per-domain routers (extracted from this file) -----------------------
import { createBookmarksRouter } from './routes/bookmarks.js';
import { createMealsRouter } from './routes/meals.js';
import { createDigRouter } from './routes/dig.js';
import { createWordcloudRouter } from './routes/wordcloud.js';
import { createDictionaryRouter } from './routes/dictionary.js';
import { createDiaryRouter } from './routes/diary.js';
import { createTrendsRouter } from './routes/trends.js';
import { createRecommendationsRouter } from './routes/recommendations.js';
import { createPushRouter } from './routes/push.js';
import { createAdminRouter } from './routes/admin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MEMORIA_PORT ?? 5180);
const DATA_DIR = resolve(process.env.MEMORIA_DATA ?? join(__dirname, '..', 'data'));
const HTML_DIR = join(DATA_DIR, 'html');
const MEAL_DIR = join(DATA_DIR, 'meals');
const DB_PATH = join(DATA_DIR, 'memoria.db');
const CLAUDE_BIN = process.env.MEMORIA_CLAUDE_BIN ?? 'claude';

mkdirSync(HTML_DIR, { recursive: true });
mkdirSync(MEAL_DIR, { recursive: true });
const db = openDb(DB_PATH);
ensureUserStopwordsTable(db);
loadLlmConfigFromSettings(getAppSettings(db));
initWebPush(DATA_DIR);
const HEARTBEAT_FILE = join(DATA_DIR, 'heartbeat.json');
startUptimeTracking({ db, dataDir: DATA_DIR, heartbeatFile: HEARTBEAT_FILE });
const summaryQueue = new FifoQueue();
const cloudQueue = new FifoQueue();
const domainCatalogQueue = new FifoQueue();
const pageMetadataQueue = new FifoQueue();
const mealVisionQueue = new FifoQueue();
const digQueue = new FifoQueue();
const diaryQueue = new FifoQueue();
const weeklyQueue = new FifoQueue();

// ---- background helpers (closures over db + queues) ---------------------

function maybeQueuePageMetadata(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); }
  catch { return; }
  if (shouldSkipDomain(host)) return;
  if (getPageMetadata(db, url)) return;
  insertPageMetadataPending(db, url);
  pageMetadataQueue.enqueue(async () => {
    const result = await fetchPageMetadata({ url });
    if (result.skip) {
      deletePageMetadata(db, url);
      return;
    }
    if (result.dropRow) {
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

function extractDomainFromUrl(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
}

function maybeQueueDomain(url) {
  const domain = extractDomainFromUrl(url);
  if (!domain) return;
  if (shouldSkipDomain(domain)) return;
  // Cheap dedup: if we already have a row, skip. Pending rows count too.
  if (getDomainCatalog(db, domain)) return;
  insertDomainPending(db, domain);
  domainCatalogQueue.enqueue(async () => {
    const result = await classifyDomain({ domain });
    if (result.skip) {
      deleteDomainCatalog(db, domain);
      return;
    }
    if (result.dropRow) {
      // 404 / DNS error / non-2xx → drop the row entirely so it can be retried later.
      deleteDomainCatalog(db, domain);
      console.log(`[domain-catalog] dropped ${domain}: ${result.error}`);
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

// ブクマ AI 要約完了の push 通知は batch 化する。 個別通知は頻度過多
// (一度に 10〜30 件まとめて入れる運用) なので、 5 件 or 5 分でまとめて 1 回。
const bookmarkPushState = { items: /** @type {{id: number; title: string}[]} */ ([]), timer: /** @type {NodeJS.Timeout | null} */ (null) };
const BOOKMARK_PUSH_BATCH_SIZE = 5;
const BOOKMARK_PUSH_DEBOUNCE_MS = 5 * 60_000;

function flushBookmarkSummaryPush() {
  if (bookmarkPushState.items.length === 0) return;
  const items = bookmarkPushState.items;
  bookmarkPushState.items = [];
  if (bookmarkPushState.timer) {
    clearTimeout(bookmarkPushState.timer);
    bookmarkPushState.timer = null;
  }
  const titleLines = items.slice(0, 5).map((it) => `・${(it.title || '').slice(0, 60)}`).join('\n');
  const more = items.length > 5 ? `\n…他 ${items.length - 5} 件` : '';
  sendPushToAll(db, {
    title: `📚 AI 要約完了 (${items.length} 件)`,
    body: titleLines + more,
    url: '/?tab=bookmarks',
    tag: 'memoria-bookmark-summary',
  }).catch((err) => console.warn(`[push] bookmark batch failed: ${err.message}`));
}

function notifyBookmarkSummaryDone(id, title) {
  bookmarkPushState.items.push({ id, title: title || '(untitled)' });
  if (bookmarkPushState.items.length >= BOOKMARK_PUSH_BATCH_SIZE) {
    flushBookmarkSummaryPush();
    return;
  }
  if (!bookmarkPushState.timer) {
    bookmarkPushState.timer = setTimeout(flushBookmarkSummaryPush, BOOKMARK_PUSH_DEBOUNCE_MS);
  }
}

function enqueueSummary(id) {
  const b = getBookmark(db, id);
  summaryQueue.enqueue(async () => {
    const cur = getBookmark(db, id);
    if (!cur) throw new Error('bookmark not found');
    const htmlAbs = join(HTML_DIR, cur.html_path);
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
      notifyBookmarkSummaryDone(id, cur.title);
    } catch (e) {
      setSummary(db, id, { summary: null, categories: [], status: 'error', error: e.message.slice(0, 500) });
      throw e;
    }
  }, {
    kind: 'summary',
    bookmarkId: id,
    title: b?.title ?? `id=${id}`,
    url: b?.url ?? '',
  });
}

// Recover any bookmarks left in 'pending' from a previous run.
{
  const pending = db.prepare(`SELECT id FROM bookmarks WHERE status = 'pending' ORDER BY created_at ASC`).all();
  if (pending.length > 0) {
    console.log(`[startup] re-queuing ${pending.length} pending summary job(s)`);
    for (const { id } of pending) enqueueSummary(id);
  }
}

// ---- meal vision queue helpers ------------------------------------------

const MEAL_VISION_TIMEOUT = 90_000;

function enqueueMealVision(id) {
  mealVisionQueue.enqueue(async () => {
    const meal = getMeal(db, id);
    if (!meal) return;
    const fullPath = join(MEAL_DIR, meal.photo_path);
    if (!existsSync(fullPath)) {
      updateMeal(db, id, { ai_status: 'error', ai_error: 'photo file missing' });
      return;
    }
    try {
      const result = await Promise.race([
        analyzeMealPhoto(fullPath),
        new Promise((_, reject) => setTimeout(() => reject(new Error('vision timeout')), MEAL_VISION_TIMEOUT)),
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
    } catch (e) {
      updateMeal(db, id, { ai_status: 'error', ai_error: String(e.message ?? e).slice(0, 500) });
    }
  }, { kind: 'meal-vision', meal_id: id, title: `meal #${id}` });
}

// 食品名から標準カロリーを背景で推定する。 結果は対象 meal の additions[idx]
// (idx == -1 のときは meal 本体の calories) に書き込む。 失敗は黙認 (UI に
// 「— kcal」 のままを残す)。
function enqueueCalorieEstimate(mealId, additionIdx, foodName) {
  mealVisionQueue.enqueue(async () => {
    try {
      const r = await estimateCaloriesFromName(foodName);
      if (r.calories == null) return;
      const meal = getMeal(db, mealId);
      if (!meal) return;
      if (additionIdx === -1) {
        // meal 本体のカロリーを user_corrected_calories に書く (上書きしない)
        const patch = {};
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
    } catch (e) {
      console.warn(`[meal#${mealId}] calorie estimate failed: ${e.message}`);
    }
  }, { kind: 'meal-calorie', meal_id: mealId, title: `kcal: ${foodName.slice(0, 40)}` });
}

function parseMealAdditionsJson(json) {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 起動時に pending 食事があれば解析を再投入 (前回終了時の中断分)
for (const m of listPendingMeals(db, { limit: 50 })) {
  enqueueMealVision(m.id);
}

// ---- dig queue helper (closure over digQueue + db) ---------------------
// All claude-using work (dig / cloud / diary / weekly / domain / page) runs
// strictly one job at a time so the user can watch progress in 作業リスト.

function enqueueDig(id, query, { searchEngine = 'default', theme = null } = {}) {
  // Phase 0: raw SERP scrape — runs OUTSIDE the digQueue (no LLM, no
  // serialisation) so it lands within ~2 s regardless of whatever Claude
  // job is currently in flight. Failures are silent; the UI falls through
  // to the AI preview if this comes back empty.
  runDigRawSerp({ query, searchEngine })
    .then(raw => { if (raw) setDigRawResults(db, id, raw); })
    .catch(err => console.warn(`[dig#${id}] raw serp failed: ${err.message}`));

  digQueue.enqueue(async () => {
    // 同テーマの過去セッションから topics / sources / queries を集めて、
    // LLM プロンプトに 「これまで掘った領域」 として注入。 テーマ無しなら空。
    const themeCtx = theme ? digThemeContext(db, theme) : null;

    // Phase 1: SERP preview (fast — no page fetches). Persisted as soon as
    // it lands so the FE can render before the deep claude pass finishes.
    runDigPreview({ query, searchEngine })
      .then(preview => setDigPreview(db, id, preview))
      .catch(err => console.warn(`[dig#${id}] preview failed: ${err.message}`));
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
      }).catch((err) => console.warn(`[push] dig#${id} notification failed: ${err.message}`));
    } catch (e) {
      setDigResult(db, id, { status: 'error', error: e.message.slice(0, 500) });
      throw e;
    }
  }, { kind: 'dig', sessionId: id, title: theme ? `[${theme}] ${query}` : query, search_engine: searchEngine });
}

// ---- wordcloud helpers (closures used by routers) ----------------------

const SINGLE_BOOKMARK_TEXT_LIMIT = 12000;

function buildBookmarkDoc(b) {
  let bodyText = '';
  try {
    const html = readFileSync(join(HTML_DIR, b.html_path), 'utf8');
    bodyText = htmlToText(html).slice(0, SINGLE_BOOKMARK_TEXT_LIMIT);
  } catch {}
  const cats = (b.categories || []).join(', ');
  return `Title: ${b.title}\nURL: ${b.url}\nCategories: ${cats}\nSummary: ${b.summary || ''}\n\nBody:\n${bodyText}`;
}

function enqueueCloud(id, { docs, label }) {
  cloudQueue.enqueue(async () => {
    try {
      const result = await extractWordCloud({ label, docs });
      setWordCloudResult(db, id, { status: 'done', result });
    } catch (e) {
      setWordCloudResult(db, id, { status: 'error', error: e.message.slice(0, 500) });
      throw e;
    }
  }, { kind: 'wordcloud', cloudId: id, title: label });
}

// ---- diary settings + queue (closures shared with routes/diary.js) -----

function settingsAsObject() {
  const s = getDiarySettings(db);
  return {
    github_token: s.github_token || process.env.MEMORIA_GH_TOKEN || '',
    github_user: s.github_user || process.env.MEMORIA_GH_USER || '',
    github_repos: s.github_repos
      ? s.github_repos.split(',').map(x => x.trim()).filter(Boolean)
      : [],
  };
}

// Diary generation is split across several sub-stages so each one shows up
// in the queue UI as its own work item:
//   1. 📥 GitHub fetch (if configured) — diary_github
//   2. 📝 作業内容    (Sonnet)         — diary_work
//   3. ✨ ハイライト  (Opus 1M)         — diary_highlights
function enqueueDiaryStages(dateStr, opts = {}) {
  const ctx = {
    metrics: null,
    github: null,
    notes: '',
    workContent: '',
    githubByRepo: null,
    highlights: '',
    bookmarkSummary: null,
    // One-shot improvement instruction from the UI (not persisted).
    improve: typeof opts.improve === 'string' ? opts.improve.trim() : '',
    // Standing memo from app_settings — passed to every prompt.
    globalMemo: '',
    failed: false,
  };

  function rememberFailure(stage, e) {
    ctx.failed = true;
    upsertDiary(db, {
      date: dateStr, status: 'error', metrics: ctx.metrics || aggregateDay(db, dateStr),
      githubCommits: ctx.github, error: `[${stage}] ${e.message}`.slice(0, 500),
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

  // Stage 1: GitHub fetch (only if configured, otherwise no-op).
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
    } catch (e) {
      rememberFailure('github', e);
      throw e;
    }
  }, { kind: 'diary_github', date: dateStr, title: `📥 ${dateStr} GitHub commits` });

  // Stage 2: 作業内容 (Sonnet by default).
  diaryQueue.enqueue(async () => {
    if (ctx.failed) return;
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
    } catch (e) {
      rememberFailure('work', e);
      throw e;
    }
  }, { kind: 'diary_work', date: dateStr, title: `📝 ${dateStr} 作業内容 (Sonnet)` });

  // Stage 3: ハイライト (Opus 1M by default) — depends on stage 2.
  diaryQueue.enqueue(async () => {
    if (ctx.failed) return;
    try {
      ctx.githubByRepo = summarizeGithubByRepo(ctx.github);
      const created = ctx.metrics?.bookmarks?.created || [];
      const accessed = ctx.metrics?.bookmarks?.accessed || [];
      const domSet = new Set();
      for (const b of [...created, ...accessed]) {
        try { domSet.add(new URL(b.url).hostname); } catch {}
      }
      ctx.bookmarkSummary = {
        created: created.length,
        accessed: accessed.length,
        topDomains: [...domSet].slice(0, 8),
      };
      const digs = ctx.metrics.digs || [];
      ctx.highlights = await generateHighlights({
        dateStr,
        workContent: ctx.workContent,
        githubByRepo: ctx.githubByRepo,
        bookmarkSummary: ctx.bookmarkSummary,
        digs, notes: ctx.notes, metrics: ctx.metrics,
        globalMemo: ctx.globalMemo,
        improve: ctx.improve,
      });
      const summary = composeDiarySummary({
        workContent: ctx.workContent,
        githubByRepo: ctx.githubByRepo,
        highlights: ctx.highlights,
        digs,
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
      }).catch((err) => {
        console.warn(`[push] diary notification failed: ${err.message}`);
      });
    } catch (e) {
      rememberFailure('highlights', e);
      throw e;
    }
  }, { kind: 'diary_highlights', date: dateStr, title: `✨ ${dateStr} ハイライト (Opus 1M)` });
}

// Mirror of `composeSummary` from diary.js — extracted here so we can run
// the highlights stage independently in the queue chain.
function composeDiarySummary({ workContent, githubByRepo, highlights, digs }) {
  const parts = [];
  if (workContent) parts.push(`## 作業内容\n${workContent.trim()}`);
  if (digs && digs.length > 0) {
    const digLines = digs.map(d => {
      const head = `- 「${d.query}」 (${d.source_count} 件のソース)`;
      return d.summary ? `${head}\n  ${d.summary.slice(0, 250)}` : head;
    }).join('\n');
    parts.push(`## ディグ調査\n${digLines}`);
  }
  if (githubByRepo?.repos?.length) {
    const repoLines = githubByRepo.repos.map(r => `- ${r.repo}: ${r.count} commits`).join('\n');
    parts.push(`## GitHub commits (${githubByRepo.total} 件)\n${repoLines}`);
  }
  if (highlights) parts.push(`## ハイライト\n${highlights.trim()}`);
  return parts.join('\n\n');
}

async function runDiaryGeneration(dateStr) {
  // Legacy single-step path kept for the weekly job, which orchestrates
  // its own run. The queued user-facing path goes through enqueueDiaryStages.
  const metrics = aggregateDay(db, dateStr);
  const settings = settingsAsObject();
  upsertDiary(db, { date: dateStr, status: 'pending', metrics, error: null });

  let github = null;
  if (settings.github_user) {
    github = await fetchGithubActivity({
      token: settings.github_token,
      user: settings.github_user,
      repos: settings.github_repos,
      dateStr,
    });
  }

  const prior = getDiary(db, dateStr);
  const notes = prior?.notes || '';

  let result;
  try {
    result = await generateDiary({
      db, dateStr, metrics, github, notes,
    });
  } catch (e) {
    upsertDiary(db, {
      date: dateStr, status: 'error', metrics,
      githubCommits: github, error: e.message.slice(0, 500),
    });
    throw e;
  }

  upsertDiary(db, {
    date: dateStr,
    summary: result.summary,
    workContent: result.workContent,
    workMinutes: result.workMinutes,
    highlights: result.highlights,
    metrics,
    githubCommits: github,
    status: 'done',
    error: null,
  });
}

function enqueueDiary(dateStr, opts = {}) {
  // User-facing diary regenerate. Splits into prepare → github → work →
  // highlights so each LLM/IO step is its own queue entry.
  enqueueDiaryStages(dateStr, opts);
}

// ---- weekly report queue --------------------------------------------------

async function runWeeklyGeneration(weekStart) {
  const range = weekRangeFor(weekStart);
  const { weekInMonth, month } = weekOfMonth(range.start);
  upsertWeekly(db, {
    weekStart: range.start, weekEnd: range.end, month, weekInMonth,
    status: 'pending', error: null,
  });

  // Pull the 7 daily diaries (use whichever pieces are available).
  const dailyDiaries = listDiariesInRange(db, { start: range.start, end: range.end });

  // Pull commits across the week from configured repos.
  const settings = settingsAsObject();
  let githubByRepo = { repos: [], total: 0 };
  if (settings.github_user && settings.github_repos.length > 0) {
    const since = `${range.start}T00:00:00Z`;
    const until = `${range.end}T23:59:59Z`;
    const fetched = await fetchGithubRange({
      token: settings.github_token, user: settings.github_user,
      repos: settings.github_repos, since, until,
    });
    githubByRepo = summarizeGithubByRepo(fetched);
  }

  let summary;
  try {
    summary = await generateWeekly({
      weekStart: range.start, weekEnd: range.end,
      dailyDiaries, githubByRepo,
    });
  } catch (e) {
    upsertWeekly(db, {
      weekStart: range.start, status: 'error', githubSummary: githubByRepo,
      error: e.message.slice(0, 500),
    });
    throw e;
  }

  upsertWeekly(db, {
    weekStart: range.start, summary,
    githubSummary: githubByRepo,
    status: 'done', error: null,
  });
}

function enqueueWeekly(weekStart) {
  weeklyQueue.enqueue(async () => {
    await runWeeklyGeneration(weekStart);
  }, { kind: 'weekly', weekStart, title: weekStart });
}

// ---- HTTP fetch helper (used by bulkSaveUrls + multi/download) ---------

async function fetchPageHtml(url, timeoutMs = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Memoria/0.2',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(ct)) {
      throw new Error(`unsupported content-type: ${ct}`);
    }
    const html = await res.text();
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = m ? decodeHtmlEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
    return { html, title };
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

// ---- WebSocket broadcaster (used by /api/locations/ingest + MQTT) ------

/** @type {Set<import('ws').WebSocket>} */
const wsClients = new Set();

function broadcastLocation(point) {
  if (wsClients.size === 0) return;
  const msg = JSON.stringify({ type: 'location', point });
  for (const c of wsClients) {
    if (c.readyState === 1 /* OPEN */) {
      try { c.send(msg); } catch {}
    }
  }
}

// ---- Hono app + middleware -----------------------------------------------

const app = new Hono();
app.use('/api/*', cors({ origin: '*', allowMethods: ['GET','POST','PATCH','DELETE','OPTIONS'] }));

// 構造化 access ログ
app.use('*', async (c, next) => {
  const t0 = Date.now();
  let thrown;
  try { await next(); } catch (err) { thrown = err; throw err; }
  finally {
    const status = c.res?.status ?? (thrown ? 500 : 0);
    const entry = {
      ts: new Date().toISOString(),
      method: c.req.method, path: c.req.path,
      status, durationMs: Date.now() - t0,
    };
    if (thrown) entry.error = thrown instanceof Error ? thrown.message : String(thrown);
    const tag = status >= 500 ? '[http-error]' : status >= 400 ? '[http-warn]' : '[http]';
    console.log(`${tag} ${JSON.stringify(entry)}`);
  }
});

// ---- mount per-domain routers --------------------------------------------
//
// admin.js owns `bulkSaveUrls` (because it handles /api/visits/bookmark
// which uses the same closure). routes/dig.js shares it via deps so the
// implementation lives in one place.

const adminBundle = createAdminRouter({
  db, HTML_DIR, PORT, DATA_DIR,
  summaryQueue, cloudQueue, digQueue, diaryQueue, weeklyQueue,
  domainCatalogQueue, pageMetadataQueue, mealVisionQueue,
  listAllCategories, upsertVisit, insertVisitEvent,
  listUnsavedVisits, listSuggestedVisits, deleteVisit,
  findBookmarkByUrl, recordAccess, insertBookmark, insertImportedBookmark,
  getBookmark, listBookmarks, listServerEvents,
  getDomainCatalog, listDomainCatalogWithCounts, getDomainCatalogMap,
  insertDomainPending, setDomainCatalog, deleteDomainCatalog,
  updateDomainCatalogUser, classifyDomain, shouldSkipDomain,
  getPageMetadataMap,
  insertGpsLocation, listGpsLocationsInRange, listGpsLocationDays,
  listGpsLocationsForDate, deleteGpsLocationsOlderThan,
  getAppSettings, setAppSettings,
  getLlmConfig, loadLlmConfigFromSettings, settingsPatchFromConfig,
  LLM_TASKS, LLM_PROVIDERS,
  enqueueSummary, fetchPageHtml,
  maybeQueueDomain, maybeQueuePageMetadata, extractDomainFromUrl,
  broadcastLocation, readHeartbeat, HEARTBEAT_FILE, DOWNTIME_THRESHOLD_MS,
});
const bulkSaveUrls = adminBundle.bulkSaveUrls;

app.route('/api', createBookmarksRouter({
  db, HTML_DIR,
  insertBookmark, setSummary, listBookmarks, countBookmarks, getBookmark,
  updateMemoAndCategories, deleteBookmark, recordAccess, findBookmarkByUrl,
  listAccesses, getBookmarkWordCloud, insertWordCloud,
  enqueueSummary, enqueueCloud, buildBookmarkDoc, summaryQueue,
}));

app.route('/api/meals', createMealsRouter({
  db, MEAL_DIR,
  insertMeal, getMeal, listMeals, countMeals, updateMeal, deleteMeal,
  extractPhotoMeta, resolveMealLocation,
  enqueueMealVision, enqueueCalorieEstimate,
}));

app.route('/api/dig', createDigRouter({
  db,
  insertDigSession, getDigSession, listDigSessions, deleteDigSession,
  listDigThemes, listSearchEngines, deriveDigTheme,
  enqueueDig, bulkSaveUrls,
}));

app.route('/api/wordcloud', createWordcloudRouter({
  db, listBookmarks, getDigSession, getBookmark,
  insertWordCloud, setWordCloudResult, getWordCloud, listWordClouds,
  enqueueCloud, validateWordRelevance,
}));

app.route('/api', createDictionaryRouter({
  db,
  listDictionaryEntries, getDictionaryEntry, findDictionaryEntryByTerm,
  insertDictionaryEntry, updateDictionaryEntry, deleteDictionaryEntry,
  addDictionaryLink, removeDictionaryLink,
  listUserStopwords, addUserStopword, removeUserStopword,
}));

app.route('/api', createDiaryRouter({
  db, diaryQueue,
  enqueueDiary, enqueueWeekly,
  getDiary, listDiariesInRange, upsertDiary, deleteDiary,
  bookmarksForDate, digSessionsForDate,
  settingsAsObject, setDiarySettings, pingGithub,
  getWeekly, listWeeklyForMonth, deleteWeekly,
  weekRangeFor, weekOfMonth, aggregateDay,
}));

app.route('/api/trends', createTrendsRouter({
  db,
  trendsCategories, trendsCategoryDiff, trendsTimeline, trendsDomains,
  trendsVisitDomains, trendsWorkHours, trendsKeywords, trendsGpsWalking,
  fetchGithubRange, settingsAsObject,
}));

app.route('/api/recommendations', createRecommendationsRouter({
  db, HTML_DIR,
  recommendationsFor, dismissRecommendation, clearDismissals,
}));

app.route('/api/push', createPushRouter({
  db,
  getVapidPublicKey, saveSubscription, sendPushToAll,
  listPushSubscriptions, deletePushSubscription,
}));

app.route('/api', adminBundle.router);

// ---- /api/multi/* (Memoria Hub client) ----------------------------------
//
// These remain in index.js because they coordinate multi-server state
// (JWT, OAuth bounce, proxy) and are tightly tied to readMultiState /
// fetchPageHtml + the bookmark / dig / dictionary download flow.

app.get('/api/multi/status', (c) => {
  const { servers, active } = readMultiServers(db);
  const list = servers.map(s => ({
    label: s.label, url: s.url,
    active: active.has(s.url),
    connected: !!(s.jwt && s.userId),
    user: s.userId ? { id: s.userId, name: s.userName, role: s.role } : null,
    connected_at: s.connectedAt,
  }));
  const primary = readMultiState(db);
  return c.json({
    servers: list,
    connected: isConnected(primary),
    url: primary.url,
    user: isConnected(primary) ? { id: primary.userId, name: primary.userName, role: primary.role } : null,
    connected_at: primary.connectedAt,
  });
});

app.post('/api/multi/servers', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.url) return c.json({ error: 'url required' }, 400);
  const { servers, active } = readMultiServers(db);
  const updated = upsertServer(servers, { label: body.label || body.url, url: body.url });
  persistServers(db, updated, active);
  return c.json({ ok: true });
});

app.delete('/api/multi/servers', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.url) return c.json({ error: 'url required' }, 400);
  const { servers, active } = readMultiServers(db);
  active.delete(String(body.url).replace(/\/$/, ''));
  persistServers(db, removeServer(servers, body.url), active);
  return c.json({ ok: true });
});

app.post('/api/multi/active', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body?.urls)) return c.json({ error: 'urls[] required' }, 400);
  setActive(db, body.urls);
  return c.json({ ok: true });
});

app.post('/api/multi/connect', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.url) return c.json({ error: 'url required' }, 400);
  const { servers, active } = readMultiServers(db);
  const updated = upsertServer(servers, { label: body.label || body.url, url: body.url });
  persistServers(db, updated, active);
  const redirectBack = body.redirect_uri || 'http://localhost:5180/?multi=connected';
  const start = `${body.url.replace(/\/$/, '')}/api/auth/start?redirect_uri=${encodeURIComponent(redirectBack)}`;
  return c.json({ ok: true, authorize_url: start });
});

app.post('/api/multi/finish', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.jwt) return c.json({ error: 'jwt required' }, 400);
  const { servers } = readMultiServers(db);
  const target = body.url
    ? servers.find(s => s.url === String(body.url).replace(/\/$/, ''))
    : servers[servers.length - 1];
  if (!target) return c.json({ error: 'no multi server registered' }, 400);
  let me;
  try { me = await fetchMe({ ...target, jwt: body.jwt }); }
  catch (e) { return c.json({ error: `verify failed: ${e.message}` }, 401); }
  saveServerSession(db, target.url, {
    jwt: body.jwt,
    userId: me.userId,
    userName: me.displayName,
    role: me.role,
  });
  return c.json({ ok: true, url: target.url, user: me });
});

app.post('/api/multi/disconnect', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body?.url) {
    clearServerSession(db, body.url);
  } else {
    const { servers } = readMultiServers(db);
    for (const s of servers) clearServerSession(db, s.url);
  }
  return c.json({ ok: true });
});

async function proxyMulti(c, method) {
  const state = readMultiState(db);
  if (!isConnected(state)) return c.json({ error: 'not_connected' }, 400);
  const path = c.req.path.replace('/api/multi/proxy', '');
  if (method === 'POST' && !path.startsWith('/api/shared/moderation/')) {
    return c.json({ error: 'forbidden_proxy_write' }, 403);
  }
  const qs = new URL(c.req.url).search;
  const upstream = `${state.url.replace(/\/$/, '')}${path}${qs}`;
  const init = {
    method,
    headers: {
      'Authorization': `Bearer ${state.jwt}`,
      'Accept': 'application/json',
    },
  };
  if (method === 'POST') {
    init.headers['Content-Type'] = 'application/json';
    init.body = await c.req.text();
  }
  try {
    const res = await fetch(upstream, init);
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'application/json',
      },
    });
  } catch (e) {
    return c.json({ error: `proxy failed: ${e.message}` }, 502);
  }
}
app.get('/api/multi/proxy/*', (c) => proxyMulti(c, 'GET'));
app.post('/api/multi/proxy/*', (c) => proxyMulti(c, 'POST'));

app.post('/api/multi/share', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.kind || body.id == null) return c.json({ error: 'kind+id required' }, 400);
  const state = readMultiState(db);
  if (!isConnected(state)) return c.json({ error: 'not_connected' }, 400);

  try {
    if (body.kind === 'bookmark') {
      const b = getBookmark(db, body.id);
      if (!b) return c.json({ error: 'not_found' }, 404);
      const r = await shareBookmark(state, b);
      markBookmarkShared(db, body.id, { sharedAt: r.shared_at, sharedOrigin: state.url });
      return c.json({ ok: true, remote: r });
    }
    if (body.kind === 'dig') {
      const d = getDigSession(db, body.id);
      if (!d) return c.json({ error: 'not_found' }, 404);
      const r = await shareDig(state, {
        query: d.query, status: d.status, result: d.result,
      });
      markDigShared(db, body.id, { sharedAt: r.shared_at, sharedOrigin: state.url });
      return c.json({ ok: true, remote: r });
    }
    if (body.kind === 'dict') {
      const e = getDictionaryEntry(db, body.id);
      if (!e) return c.json({ error: 'not_found' }, 404);
      const r = await shareDictionary(state, e);
      markDictionaryShared(db, body.id, { sharedAt: r.shared_at, sharedOrigin: state.url });
      return c.json({ ok: true, remote: r });
    }
    return c.json({ error: 'unknown kind' }, 400);
  } catch (e) {
    console.error('[multi/share]', e);
    return c.json({ error: e.message }, e.status || 500);
  }
});

app.post('/api/multi/download', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.kind || body.remote_id == null) return c.json({ error: 'kind+remote_id required' }, 400);
  const state = readMultiState(db);
  if (!isConnected(state)) return c.json({ error: 'not_connected' }, 400);

  try {
    if (body.kind === 'bookmark') {
      const remote = await multiFetch(state,`/api/shared/bookmarks/${body.remote_id}`);
      const escapeHtml = (s = '') => String(s).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[ch]));
      let htmlBody;
      try { htmlBody = (await fetchPageHtml(remote.url)).html; }
      catch (e) {
        htmlBody = `<!-- downloaded from ${state.url}; original fetch failed: ${e.message} -->\n<html><head><title>${escapeHtml(remote.title || '')}</title></head><body></body></html>`;
      }
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safe = ts + '_' + Math.random().toString(36).slice(2, 8) + '.html';
      writeFileSync(join(HTML_DIR, safe), htmlBody, 'utf8');
      const ins = insertImportedBookmark(db, {
        url: remote.url,
        title: remote.title,
        html_path: safe,
        summary: remote.summary,
        memo: remote.memo,
        categories: remote.categories || [],
      });
      if (ins.skipped) return c.json({ ok: true, duplicate: true, id: ins.id });
      setBookmarkOwner(db, ins.id, {
        ownerUserId: remote.owner_user_id,
        ownerUserName: remote.owner_user_name,
        sharedAt: remote.shared_at,
        sharedOrigin: state.url,
      });
      return c.json({ ok: true, id: ins.id });
    }
    if (body.kind === 'dig') {
      const remote = await multiFetch(state,`/api/shared/digs/${body.remote_id}`);
      const id = insertDigSession(db, remote.query);
      setDigResult(db, id, {
        status: remote.status || 'done',
        result: remote.result_json || remote.result || null,
        error: null,
      });
      setDigOwner(db, id, {
        ownerUserId: remote.owner_user_id,
        ownerUserName: remote.owner_user_name,
        sharedAt: remote.shared_at,
        sharedOrigin: state.url,
      });
      return c.json({ ok: true, id });
    }
    if (body.kind === 'dict') {
      const remote = await multiFetch(state,`/api/shared/dictionary/${body.remote_id}`);
      const namespacedTerm = remote.owner_user_id
        ? `${remote.term} (@${remote.owner_user_name || remote.owner_user_id})`
        : remote.term;
      const existing = findDictionaryEntryByTerm(db, namespacedTerm);
      let id;
      if (existing) {
        updateDictionaryEntry(db, existing.id, {
          definition: remote.definition,
          notes: remote.notes,
        });
        id = existing.id;
      } else {
        id = insertDictionaryEntry(db, {
          term: namespacedTerm,
          definition: remote.definition,
          notes: remote.notes,
        });
      }
      setDictionaryOwner(db, id, {
        ownerUserId: remote.owner_user_id,
        ownerUserName: remote.owner_user_name,
        sharedAt: remote.shared_at,
        sharedOrigin: state.url,
      });
      return c.json({ ok: true, id });
    }
    return c.json({ error: 'unknown kind' }, 400);
  } catch (e) {
    console.error('[multi/download]', e);
    return c.json({ error: e.message }, e.status || 500);
  }
});

// ---- PWA Web Share Target -----------------------------------------------
//
// PWA share_target (manifest.webmanifest) routes the OS share sheet here on
// Android. iOS has no PWA share_target — the iOS Shortcut template in
// docs/mobile-share.md drives this same endpoint instead.
function extractShareUrl(q) {
  const direct = (q.get('url') || '').trim();
  if (/^https?:\/\//i.test(direct)) return direct;
  for (const key of ['text', 'title']) {
    const v = (q.get(key) || '').trim();
    const m = v.match(/https?:\/\/\S+/i);
    if (m) return m[0].replace(/[.,;:!?)\]]+$/g, '');
  }
  return null;
}

app.get('/share', async (c) => {
  const q = new URL(c.req.url).searchParams;
  const target = extractShareUrl(q);
  if (!target) {
    return c.redirect('/?share=invalid', 303);
  }
  bulkSaveUrls([target]).catch(err => {
    console.error('[share] bulkSaveUrls failed:', err.message);
  });
  return c.redirect('/?share=ok&u=' + encodeURIComponent(target), 303);
});

// ---- Midnight + Sunday-evening crons -----------------------------------

// Midnight scheduler — fires at next 00:00:05 local, generates the previous
// day's diary, then re-schedules itself.
function scheduleMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  const ms = next.getTime() - now.getTime();
  setTimeout(async () => {
    try {
      const dateStr = yesterdayLocal();
      console.log(`[diary cron] generating ${dateStr}`);
      enqueueDiary(dateStr);
    } catch (e) {
      console.error('[diary cron] failed:', e.message);
    }
    scheduleMidnight();
  }, Math.max(60_000, ms)).unref?.();
}
scheduleMidnight();

// Sunday 23:00 cron — summarises Mon-Sun of the current week.
function scheduleSundayEvening() {
  const now = new Date();
  const next = new Date(now);
  const dow = now.getDay();
  const daysUntilSunday = dow === 0 ? 0 : (7 - dow); // 0=Sun,1=Mon,...6=Sat
  next.setDate(now.getDate() + daysUntilSunday);
  next.setHours(23, 0, 5, 0);
  if (next <= now) next.setDate(next.getDate() + 7);
  const ms = next.getTime() - now.getTime();
  setTimeout(async () => {
    try {
      // Today (Sunday) is the end of the week we're summarising.
      const today = new Date();
      const range = weekRangeFor(formatLocalDate(today));
      console.log(`[weekly cron] generating week ${range.start}`);
      enqueueWeekly(range.start);
    } catch (e) {
      console.error('[weekly cron] failed:', e.message);
    }
    scheduleSundayEvening();
  }, Math.max(60_000, ms)).unref?.();
}
scheduleSundayEvening();

// ---- static UI ----------------------------------------------------------

app.use('/*', serveStatic({ root: './public' }));
app.get('/', serveStatic({ path: './public/index.html' }));

// ---- HTTP server + WebSocket --------------------------------------------
//
// `@hono/node-server::serve` は内部で http.Server を作って listen するので、
// その server hook (戻り値) に対して `ws` ライブラリで WebSocketServer を
// attach すれば HTTP / WS を同 port で兼ねられる。

const httpServer = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Memoria server listening on http://localhost:${info.port}`);
  console.log(`  data dir: ${DATA_DIR}`);
  console.log(`  claude bin: ${CLAUDE_BIN}`);
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/ws/locations')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
  // 接続直後の hello (UI 側で接続成立を確認しやすくする)
  try { ws.send(JSON.stringify({ type: 'hello', ts: Date.now() })); } catch {}
});

// keep-alive: 30s ごとに ping。 Cloudflare の idle timeout (100s 程度) を超えない。
setInterval(() => {
  for (const c of wsClients) {
    if (c.readyState === 1) {
      try { c.ping(); } catch {}
    }
  }
}, 30_000).unref?.();

// ---- in-process MQTT subscriber (任意) ----------------------------------
//
// MEMORIA_MQTT_URL が設定されていれば、 main server process 内で OwnTracks
// subscriber を立てる。 別 process の owntracks-server.js は legacy として
// 残るが、 in-process にすると WebSocket broadcaster (broadcastLocation) を
// 直接呼べるので UI も即時更新される。

if (process.env.MEMORIA_MQTT_URL) {
  try {
    const { loadOwntracksConfig } = await import('./owntracks/config.js');
    const { startOwntracksClient } = await import('./owntracks/client.js');
    const { locationToDbRecord } = await import('./owntracks/payload.js');
    const cfg = loadOwntracksConfig();
    console.log(`[mqtt] in-process subscriber starting (url=${cfg.mqtt.url}, topic=${cfg.mqtt.topic})`);
    startOwntracksClient(cfg, async (topic, loc, ctx) => {
      const rec = locationToDbRecord(topic, loc, {
        userId: cfg.userId,
        rawJson: ctx.rawJson,
      });
      const result = insertGpsLocation(db, rec);
      if (!result.skipped) {
        broadcastLocation({
          id: result.id,
          user_id: rec.userId,
          device_id: rec.deviceId,
          recorded_at: new Date(rec.tst * 1000).toISOString(),
          lat: rec.lat,
          lon: rec.lon,
          accuracy_m: rec.accuracy ?? null,
          altitude_m: rec.altitude ?? null,
          velocity_kmh: rec.velocity ?? null,
          course_deg: rec.course ?? null,
        });
        console.log(
          `[mqtt] insert id=${result.id} ${rec.deviceId ?? '?'} ` +
          `(${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)})`
        );
      }
    });
  } catch (e) {
    console.error(`[mqtt] in-process subscriber failed to start: ${e?.message ?? e}`);
  }
}
