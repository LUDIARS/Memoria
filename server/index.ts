// Memoria server entry point.
//
// 各 domain の router (routes/<domain>.ts) を mount し、 共通 middleware
// (CORS, access log, static SPA) を貼って Hono アプリを組み立てる。
// 起動シーケンスは:
//   1. env / dirs を解決
//   2. openDb + 各種 init (push / uptime / stopwords / diary sidecar)
//   3. queues / WS / scheduler / legatus subscriber を組み立て
//   4. router を mount
//   5. listen → WebSocketServer attach → MCP autostart

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb, ensureUserStopwordsTable,
  getAppSettings, setDiaryDataDir, migrateDiariesToSidecar,
  insertGpsLocation, listPendingMeals,
} from './db.js';
import { resolveUnresolvedBatch } from './lib/place-resolver.js';
import { loadLlmConfigFromSettings } from './llm.js';
import { initWebPush } from './push.js';
import { startUptimeTracking } from './local/uptime.js';

import { makeQueues } from './lib/queues.js';
import { makeWsLocations } from './lib/ws-locations.js';
import { startSchedulers } from './lib/scheduler.js';
import { makeMcpServer } from './lib/mcp-server.js';
import { startLegatusSubscriber } from './lib/legatus-subscriber.js';
import { startMqttBroker } from './mqtt/broker.js';
import { startDiscordBot } from './discord/index.js';
import { startWifiLocation } from './wifi-location.js';
import { fetchPageHtml } from './lib/fetch-page.js';
import { privacySettings } from './lib/privacy.js';

import { makeBookmarkRouter } from './routes/bookmark.js';
import { makeDigRouter } from './routes/dig.js';
import { makeDomainRouter } from './routes/domain.js';
import { makeVisitRouter } from './routes/visit.js';
import { makeDictRouter } from './routes/dict.js';
import { makeMealRouter } from './routes/meal.js';
import { makeDiscordRouter } from './routes/discord.js';
import { makeDiaryRouter } from './routes/diary.js';
import { makeTaskRouter } from './routes/task.js';
import { makeAgentRouter } from './routes/agent.js';
import { makeWorkplaceRouter } from './routes/workplace.js';
import { makeAttendanceRouter } from './routes/attendance.js';
import { makeActivityRouter } from './routes/activity.js';
import { configureActivitySamplers } from './lib/activity-sampler.js';
import { makeImplRouter } from './routes/impl.js';
import { makePushRouter } from './routes/push.js';
import { makeNoteRouter } from './routes/note.js';
import { makeConfigRouter } from './routes/config.js';
import { makeMultiRouter } from './routes/multi.js';
import { makeMultiProxyMiddleware } from './local/multi-proxy.js';
import { makeMiscRouter } from './routes/misc.js';
import { makeReviewRouter, seedReviewTargets } from './routes/review.js';
import { makeRepoRouter } from './routes/repo.js';
import { makePacketMonitorRouter } from './routes/packet-monitor.js';
import { seedStationsIfEmpty } from './lib/transit-stations-seed.js';
import { makeWeatherRouter } from './routes/weather.js';
import { makeBlackBoxRouter } from './routes/blackbox.js';
import { makeBlackBoxEngine } from './blackbox/index.js';
import { DOMAIN_WILL_RAIN, DOMAIN_LIKELY_PLACE } from './weather/domains.js';
import { makeTransitRouter } from './routes/transit.js';
import { makeStalenessRouter } from './routes/staleness.js';
import { makeRssRouter } from './routes/rss.js';
import { makeBriefingRouter } from './routes/briefing.js';
import { makeGoalEvalRouter } from './goals/router.js';

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
// Diary 本文の太い JSON 列 (metrics_json / github_commits_json) は
// `<DATA_DIR>/diary/<date>.json` に切り出す。 既存行は起動時に 1 回だけ
// 移行する (idempotent、 行数 0 なら no-op)。
setDiaryDataDir(DATA_DIR);
const _diaryMig = migrateDiariesToSidecar(db);
if (_diaryMig.moved > 0) {
  console.log(`[diary] migrated ${_diaryMig.moved} row(s) to sidecar JSON`);
}
loadLlmConfigFromSettings(getAppSettings(db));
initWebPush(DATA_DIR);
const HEARTBEAT_FILE = join(DATA_DIR, 'heartbeat.json');
startUptimeTracking({ db, dataDir: DATA_DIR, heartbeatFile: HEARTBEAT_FILE });

// ── Queues / WS / MCP ─────────────────────────────────────────────────────
const queues = makeQueues({ db, htmlDir: HTML_DIR, mealDir: MEAL_DIR });
const ws = makeWsLocations(db);
const mcp = makeMcpServer({ port: PORT, mcpDir: resolve(__dirname, '..', 'mcp-server') });

// Recover any bookmarks left in 'pending' from a previous run.
{
  const pending = db.prepare(`SELECT id FROM bookmarks WHERE status = 'pending' ORDER BY created_at ASC`).all() as { id: number }[];
  if (pending.length > 0) {
    console.log(`[startup] re-queuing ${pending.length} pending summary job(s)`);
    for (const { id } of pending) queues.enqueueSummary(id);
  }
}

// 起動時に pending 食事があれば解析を再投入 (前回終了時の中断分)
for (const m of listPendingMeals(db, { limit: 50 })) {
  queues.enqueueMealVision(m.id);
}

// 起動時に pending 日記があれば再投入。 diaryQueue は in-memory なので、
// 真夜中 cron が走った直後に server が再起動すると stage 0 だけ済んだ
// status='pending' な行が残ったままになる。 直近 14 日ぶんを限度に拾う
// (古すぎる pending は metrics 元データが失われている可能性があるので諦める)。
{
  const pendingDiaries = db.prepare(
    `SELECT date FROM diary_entries
     WHERE status = 'pending'
       AND date >= date('now', '-14 days', 'localtime')
     ORDER BY date DESC`,
  ).all() as { date: string }[];
  if (pendingDiaries.length > 0) {
    console.log(`[startup] re-queuing ${pendingDiaries.length} pending diary job(s): ${pendingDiaries.map((d) => d.date).join(', ')}`);
    for (const { date } of pendingDiaries) queues.enqueueDiary(date);
  }
}

// レビュー対象を LUDIARS clone から自動 seed (= 既存に追加するだけで、 ユーザが
// UI で追加した行は触らない)。
try {
  const seedResult = seedReviewTargets(db);
  if (seedResult.seeded > 0) {
    console.log(`[startup] seeded ${seedResult.seeded} review target(s) from LUDIARS clones (${seedResult.skipped} skipped)`);
  }
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.warn(`[startup] review target seed failed: ${msg}`);
}

// stations マスタを HeartRails Express から非同期 import (初回起動時のみ)。
// 47 都道府県 × 0.4s で約 20 秒。 リクエストは server listen 後に流すので
// 起動 sequence を遅らせない。 完了するまで /api/transit/stations/local は
// 空配列を返す (フロントは Google Places にも fallback 可)。
setTimeout(() => {
  void seedStationsIfEmpty(db).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[startup] stations seed failed: ${msg}`);
  });
}, 10_000);

// ── App ──────────────────────────────────────────────────────────────────
const app = new Hono();
// セキュリティヘッダ (HSTS / X-Content-Type-Options / X-Frame-Options / Referrer-Policy 等)。
// クロスオリジン分離系 (COOP / COEP / CORP) は Cernere SSO ポップアップや Hub 連携を
// 壊しうるため無効化し、 副作用のない古典的なヘッダのみを付与する。
app.use(
  '*',
  secureHeaders({
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  }),
);
app.use('/api/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }));

// 構造化 access ログ
app.use('*', async (c, next) => {
  const t0 = Date.now();
  let thrown: unknown;
  try { await next(); } catch (err) { thrown = err; throw err; }
  finally {
    const status = c.res?.status ?? (thrown ? 500 : 0);
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      method: c.req.method, path: c.req.path,
      status, durationMs: Date.now() - t0,
    };
    if (thrown) entry.error = thrown instanceof Error ? thrown.message : String(thrown);
    const tag = status >= 500 ? '[http-error]' : status >= 400 ? '[http-warn]' : '[http]';
    console.log(`${tag} ${JSON.stringify(entry)}`);
  }
});

// Local Memoria は Infisical / Cernere を直接知らない設計に統一済。
// 旧 /api/setup/infisical* と writeEnvSecrets() は撤去 — Hub 連携は Hub 側 (server/multi/)
// の Infisical 設定 (= env-cli) で完結する。

// ── Multi モード proxy 層 ─────────────────────────────────────────────────
//
// Multi モード時、 Multi 対応 7 型の CRUD を Hub の /api/data/* に転送し、
// 個人ログ系は 503 local_only を返す。 Local モードでは素通り。 feature
// router より前に置く必要がある (= router に届く前に横取りする)。
app.use('/api/*', makeMultiProxyMiddleware(db));

// ── routers (mount with absolute /api/... paths inside each) ──────────────
const bulkSaveDeps = { db, htmlDir: HTML_DIR, enqueueSummary: queues.enqueueSummary };

// 成長型ブラックボックス engine (天気の雨判定 / 行きがち場所推定 + 将来の汎用ルール)。
const blackbox = makeBlackBoxEngine(db);

app.route('/', makeBookmarkRouter({
  db, htmlDir: HTML_DIR,
  summaryQueue: queues.summaryQueue,
  enqueueSummary: queues.enqueueSummary,
  fetchPageHtml,
}));
app.route('/', makeVisitRouter({
  db, htmlDir: HTML_DIR, heartbeatFile: HEARTBEAT_FILE,
  maybeQueuePageMetadata: queues.maybeQueuePageMetadata,
  maybeQueueDomain: queues.maybeQueueDomain,
  bulkSaveDeps,
}));
app.route('/', makeDigRouter({
  db,
  enqueueDig: queues.enqueueDig,
  bulkSaveDeps,
}));
app.route('/', makeDictRouter({
  db, htmlDir: HTML_DIR,
  enqueueCloud: queues.enqueueCloud,
}));
app.route('/', makeDomainRouter({
  db,
  domainCatalogQueue: queues.domainCatalogQueue,
  maybeQueueDomain: queues.maybeQueueDomain,
}));
app.route('/', makeMealRouter({
  db, mealDir: MEAL_DIR,
  enqueueMealVision: queues.enqueueMealVision,
  enqueueCalorieEstimate: queues.enqueueCalorieEstimate,
}));
app.route('/', makeDiaryRouter({
  db,
  diaryQueue: queues.diaryQueue,
  enqueueDiary: queues.enqueueDiary,
  enqueueWeekly: queues.enqueueWeekly,
}));
app.route('/', makeTaskRouter({ db }));
app.route('/', makeAgentRouter({ db, dataDir: DATA_DIR }));
app.route('/', makeWorkplaceRouter({ db }));
app.route('/', makeAttendanceRouter({ db }));
app.route('/', makeDiscordRouter({ db }));
app.route('/', makeActivityRouter({ db }));
app.route('/', makeImplRouter({ db }));
app.route('/', makePushRouter({ db }));
app.route('/', makeNoteRouter({ db, htmlDir: HTML_DIR }));
app.route('/', makeConfigRouter({
  db, port: PORT, dataDir: DATA_DIR,
  onMcpAutostartChange: (enabled) => mcp.sync(enabled),
  onActivitySettingsChange: () => configureActivitySamplers(db, { maybeQueueApplication: queues.maybeQueueApplication }),
  summaryQueue: queues.summaryQueue,
  cloudQueue: queues.cloudQueue,
  digQueue: queues.digQueue,
  diaryQueue: queues.diaryQueue,
  weeklyQueue: queues.weeklyQueue,
  domainCatalogQueue: queues.domainCatalogQueue,
  pageMetadataQueue: queues.pageMetadataQueue,
  mealVisionQueue: queues.mealVisionQueue,
  aiAnalysisQueue: queues.aiAnalysisQueue,
}));
app.route('/', makeMultiRouter({
  db,
  broadcastLocation: ws.broadcastLocation,
  broadcastLocationResolved: ws.broadcastLocationResolved,
  triggerResolveAsync: ws.triggerResolveAsync,
}));
app.route('/', makeMiscRouter({ db, htmlDir: HTML_DIR, bulkSaveDeps }));
app.route('/', makeReviewRouter({ db }));
app.route('/', makeRepoRouter({ db }));
app.route('/', makePacketMonitorRouter({
  dataDir: DATA_DIR,
  aiAnalysisQueue: queues.aiAnalysisQueue,
}));
app.route('/', makeWeatherRouter({ db, engine: blackbox.engine }));
app.route('/', makeBlackBoxRouter({
  engine: blackbox.engine,
  ledger: blackbox.ledger,
  knownDomains: [DOMAIN_WILL_RAIN, DOMAIN_LIKELY_PLACE],
}));
app.route('/', makeTransitRouter({ db }));
app.route('/', makeStalenessRouter({ db }));
app.route('/', makeRssRouter({ db }));
app.route('/', makeBriefingRouter({ db }));
app.route('/', makeGoalEvalRouter({ db }));

// ---- Corpus hub マニフェスト (VantanHub-DESIGN.md D6) ----------------------
// Memoria は横断 hub サービス Corpus から参照される leaf。 knowledge (ブクマ /
// 辞書 / ディグ / ドメイン) は scope:multi で共有可、 lifelog (日記 / 週次 /
// 食事 / 軌跡 / 活動) は scope:local で端末内に留める。 scope が「シェア可能 /
// 不可」 の境界そのもの。 panels[] は declarative rendering 確定後に追加する。
// 認証不要 (local Memoria は loopback 信頼で local Corpus が読む)。
app.get('/.well-known/corpus-service.json', (c) =>
  c.json({
    service: 'memoria',
    displayName: 'Memoria',
    version: '0.1.0',
    corpusApi: 1,
    health: '/api/server/info',
    data: [
      { id: 'bookmarks', title: 'ブックマーク', path: '/api/bookmarks', scope: 'multi' },
      { id: 'dictionary', title: '辞書', path: '/api/dictionary', scope: 'multi' },
      { id: 'dig', title: 'ディグ', path: '/api/dig', scope: 'multi' },
      { id: 'domains', title: 'ドメイン辞書', path: '/api/domains', scope: 'multi' },
      { id: 'diary', title: '日記', path: '/api/diary', scope: 'local' },
      { id: 'weekly', title: '週次レポート', path: '/api/weekly', scope: 'local' },
      { id: 'meals', title: '食事記録', path: '/api/meals', scope: 'local' },
      { id: 'locations', title: 'GPS 軌跡', path: '/api/locations', scope: 'local' },
      { id: 'activity', title: '開発活動', path: '/api/activity/work-time', scope: 'local' },
    ],
    panels: [],
    auth: 'none',
  }),
);

// ---- static UI ------------------------------------------------------------

// SPA assets: ブラウザの aggressive cache を無効化 (古い app.js が掴まれて
// UI 機能 — Tracks の最新 GPS リスト等 — が出ない事故を防ぐ).
app.use('/*', async (c, next) => {
  await next();
  const p = c.req.path;
  if (p === '/' || p.endsWith('.html') || p.endsWith('.js') || p.endsWith('.css')) {
    c.header('cache-control', 'no-cache, must-revalidate');
  }
});
app.use('/*', serveStatic({ root: './public' }));
app.get('/', serveStatic({ path: './public/index.html' }));

// ---- HTTP server + WebSocket -------------------------------------------

const httpServer = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Memoria server listening on http://localhost:${info.port}`);
  console.log(`  data dir: ${DATA_DIR}`);
  console.log(`  claude bin: ${CLAUDE_BIN}`);
});

// 二層設計では起動時の Cernere 事前認証は廃止。 ローカルは Cernere を直接
// 叩かず、 Multi モード時に Hub の session token を使うだけ (= Hub が代理認証)。

// 起動時に未解決 GPS の backfill を 1 batch だけ走らせる. listen 直後でなく
// 5 秒遅延させて、 Memoria 起動直後のバタつき (server / WS / RAG init) と
// 重ならないようにする. API key 未設定なら全件 'failed' で帰すので副作用なし.
setTimeout(() => {
  resolveUnresolvedBatch(db, {
    limit: 100,
    stepMs: 200,
    onResolved: (id: number, result: unknown) => ws.broadcastLocationResolved(id, result as never),
  })
    .then((rsv: { processed: number; ok: number; failed: number }) => {
      if (rsv.processed > 0) {
        console.log(`[place-resolver] backfill: processed=${rsv.processed} ok=${rsv.ok} failed=${rsv.failed}`);
      }
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[place-resolver] backfill failed: ${msg}`);
    });
}, 5_000);

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/ws/locations')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (sock) => {
    wss.emit('connection', sock, req);
  });
});

wss.on('connection', (sock) => {
  ws.wsClients.add(sock);
  sock.on('close', () => ws.wsClients.delete(sock));
  sock.on('error', () => ws.wsClients.delete(sock));
  // 接続直後の hello (UI 側で接続成立を確認しやすくする)
  try { sock.send(JSON.stringify({ type: 'hello', ts: Date.now() })); } catch { /* ignore */ }
});

// MCP autostart sync (privacy.mcp_autostart_enabled に従う)
mcp.sync(privacySettings(db).mcp_autostart_enabled);
process.on('exit', () => mcp.stop());
process.on('SIGINT', () => { mcp.stop(); process.exit(0); });
process.on('SIGTERM', () => { mcp.stop(); process.exit(0); });

// keep-alive: 30s ごとに ping。 Cloudflare の idle timeout (100s 程度) を超えない。
setInterval(() => {
  for (const c of ws.wsClients) {
    if (c.readyState === 1) {
      try { c.ping(); } catch { /* ignore */ }
    }
  }
}, 30_000).unref?.();

// ── schedulers ────────────────────────────────────────────────────────────
startSchedulers({
  db,
  blackbox: blackbox.engine,
  enqueueDiary: queues.enqueueDiary,
  enqueueWeekly: queues.enqueueWeekly,
  getPrivacySettings: () => {
    const s = privacySettings(db);
    return {
      tasks_reminder_enabled: s.tasks_reminder_enabled,
      tasks_reminder_hour: s.tasks_reminder_hour,
      tasks_reminder_minute: s.tasks_reminder_minute,
      tasks_reminder_nuntius_enabled: s.tasks_reminder_nuntius_enabled,
      tasks_reminder_nuntius_url: s.tasks_reminder_nuntius_url,
    };
  },
});

// ── activity samplers (PC アプリ + Steam) ─────────────────────────────────
// feature flag が OFF なら no-op (起動時 + 設定変更時に再構成)
configureActivitySamplers(db, { maybeQueueApplication: queues.maybeQueueApplication });

// ---- in-process MQTT subscriber (任意) ----------------------------------
//
// MEMORIA_MQTT_URL が設定されていれば、 main server process 内で OwnTracks
// subscriber を立てる。
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
      if (!('skipped' in result)) {
        ws.broadcastLocation({
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
          `(${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)})`,
        );
      }
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[mqtt] in-process subscriber failed to start: ${msg}`);
  }
}

// ---- 内蔵 MQTT broker (OwnTracks 直接受信) --------------------------------
//
// 外部 Mosquitto を立てなくても、 モバイル (OwnTracks) を Tailscale 等の VPN
// 経由で直接この broker に publish させる経路。 受信 → gps_locations insert →
// /ws/locations broadcast までを 1 process で完結する。
//
// 無効化: MEMORIA_MQTT_BROKER=off
try {
  startMqttBroker({
    db,
    broadcastLocation: ws.broadcastLocation,
    triggerResolveAsync: ws.triggerResolveAsync,
  });
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[mqtt-broker] failed to start: ${msg}`);
}

// ---- Discord Bot (行動ログ取得 + 自動処理 + 通知) --------------------------
//
// features.discord.enabled かつ token/self/guild が揃っているときだけ起動。
// spec/feature/discord-bot.md。 起動失敗は best-effort で本体に影響させない。
startDiscordBot(db).catch((e: unknown) => {
  console.error(`[discord] failed to start: ${e instanceof Error ? e.message : String(e)}`);
});

// ---- PC WiFi → 位置情報 (Google Geolocation API) --------------------------
//
// モバイルが手元に無い時間帯でも PC が動いていれば BSSID 群から位置を推定
// して gps_locations に積む。 API key 未設定 or Windows 以外なら自動 disable。
try {
  startWifiLocation({
    db,
    broadcastLocation: ws.broadcastLocation,
    triggerResolveAsync: ws.triggerResolveAsync,
  });
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[wifi-location] failed to start: ${msg}`);
}

// ---- Legatus WS subscriber (legacy path, opt-in) --------------------------
//
// 旧経路: Legatus (loopback 17320) を OwnTracks → MQTT → Memoria の中継として
// 使う構成。 上の内蔵 broker が OwnTracks を直接受けるので、 既定では off。
// 互換のために残してある (MEMORIA_LEGATUS_WS=on で起動)。
if (process.env.MEMORIA_LEGATUS_WS === 'on') {
  try {
    startLegatusSubscriber({
      db,
      broadcastLocation: ws.broadcastLocation,
      triggerResolveAsync: ws.triggerResolveAsync,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[legatus-ws] subscriber failed to start: ${msg}`);
  }
}
