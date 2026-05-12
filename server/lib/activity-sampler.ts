// アプリ活動 + Steam 活動の周期サンプラ。 server 起動時に start() を呼ぶと
// 内部 timer を立ち上げて、 一定間隔で:
//   - 最前面アプリを 1 サンプリング (app_samples へ insert)
//   - Steam Web API or local VDF からプレイ統計を snapshot (steam_activity へ insert)
//
// すべて feature flag (= privacySettings) で OFF にできる。 設定変更時は
// configureActivitySamplers() を呼んで timer を再構成する。

import type BetterSqlite3 from 'better-sqlite3';
import { getForegroundApp } from './app-activity-sampler.js';
import { fetchAppDetails, getRecentlyPlayedGames, type SteamGameSnapshot } from './steam-client.js';
import { getRecentlyPlayedFromVdf } from './steam-vdf.js';
import {
  getAppSettings,
  getApplication,
  insertApplicationPending,
  listStaleAppidsFromActivity,
  setApplication,
  upsertSteamAppCache,
} from '../db.js';
import { privacySettings } from './privacy.js';

type Db = BetterSqlite3.Database;

const DEFAULT_APP_SAMPLE_SEC = 30;
const DEFAULT_STEAM_INTERVAL_MIN = 60;

let appTimer: ReturnType<typeof setInterval> | null = null;
let steamTimer: ReturnType<typeof setInterval> | null = null;
let _maybeQueueApp: ((processName: string, recentTitles?: string[]) => void) | null = null;

export interface ActivitySamplerDeps {
  /** 新規 process_name を AI 分類するため queues.maybeQueueApplication を渡す。
   *  渡さなくても sampling 自体は動く (= 分類はスキップ)。 */
  maybeQueueApplication?: (processName: string, recentTitles?: string[]) => void;
}

export function configureActivitySamplers(db: Db, deps: ActivitySamplerDeps = {}): void {
  // 都度 clear → 設定に応じて再 schedule
  if (appTimer) { clearInterval(appTimer); appTimer = null; }
  if (steamTimer) { clearInterval(steamTimer); steamTimer = null; }
  if (deps.maybeQueueApplication) _maybeQueueApp = deps.maybeQueueApplication;

  const priv = privacySettings(db);
  const settings = getAppSettings(db);
  const appSampleSec = clamp(Number(settings['activity.app_sample_sec'] ?? DEFAULT_APP_SAMPLE_SEC), 5, 600);
  const steamMin = clamp(Number(settings['activity.steam_interval_min'] ?? DEFAULT_STEAM_INTERVAL_MIN), 5, 24 * 60);

  if (priv.activity_app_sampling_enabled) {
    void sampleAppOnce(db, appSampleSec); // 起動直後に 1 サンプル
    appTimer = setInterval(() => { void sampleAppOnce(db, appSampleSec); }, appSampleSec * 1000);
    appTimer.unref?.();
    console.log(`[activity] app sampler started — interval ${appSampleSec}s`);
  }

  if (priv.activity_steam_enabled) {
    void sampleSteamOnce(db); // 起動直後に 1 スナップショット
    steamTimer = setInterval(() => { void sampleSteamOnce(db); }, steamMin * 60_000);
    steamTimer.unref?.();
    console.log(`[activity] steam sampler started — interval ${steamMin}m`);
    // 起動時に未解決 appid (= 既存の `appid:XXXXX` rows) を resolve 走らせる。
    // snapshot insert 後にも fire-and-forget で走るが、 新規 snapshot が無くても
    // 過去ぶんを後追いで埋められるようにここでも 1 度叩く。
    void resolveUnresolvedSteamApps(db).catch((e) => {
      console.warn('[activity] steam app resolve (boot) failed:', (e as Error).message);
    });
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export async function sampleAppOnce(db: Db, sampleIntervalSec: number): Promise<void> {
  const fg = await getForegroundApp();
  if (!fg) return;
  try {
    db.prepare(`
      INSERT INTO app_samples (sampled_at, process_name, window_title, sample_interval_sec)
      VALUES (datetime('now'), ?, ?, ?)
    `).run(fg.process_name, fg.window_title, sampleIntervalSec);
    // 新規 process_name なら AI 分類を enqueue (= applications カタログ)
    if (_maybeQueueApp) {
      _maybeQueueApp(fg.process_name, fg.window_title ? [fg.window_title] : undefined);
    }
  } catch (e) {
    console.warn('[activity] app sample insert failed:', (e as Error).message);
  }
}

export async function sampleSteamOnce(db: Db): Promise<{ source: 'api' | 'vdf' | 'none'; count: number; error?: string }> {
  const settings = getAppSettings(db);
  const apiKey = (settings['steam.web_api_key'] || '').trim();
  const steamId = (settings['steam.steam_id'] || '').trim();

  let games: SteamGameSnapshot[] = [];
  let source: 'api' | 'vdf' | 'none' = 'none';
  let error: string | undefined;

  if (apiKey && steamId) {
    const r = await getRecentlyPlayedGames({ apiKey, steamId });
    if (r.ok) {
      games = r.games;
      source = 'api';
    } else {
      error = r.error;
    }
  }
  // API が無い / 失敗時に VDF fallback
  if (source === 'none') {
    const r = getRecentlyPlayedFromVdf();
    if (r.ok) {
      games = r.games;
      source = 'vdf';
      error = undefined;
    } else if (!error) {
      error = r.reason;
    }
  }
  if (source === 'none' || games.length === 0) {
    if (error) console.debug('[activity] steam sample skipped:', error);
    return { source, count: 0, error };
  }

  const stmt = db.prepare(`
    INSERT INTO steam_activity
      (sampled_at, appid, name, playtime_2weeks_min, playtime_forever_min, img_icon_url)
    VALUES (datetime('now'), ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((rows: SteamGameSnapshot[]) => {
    for (const g of rows) {
      stmt.run(g.appid, g.name, g.playtime_2weeks_min, g.playtime_forever_min, g.img_icon_url);
    }
  });
  try {
    insertMany(games);
  } catch (e) {
    console.warn('[activity] steam snapshot insert failed:', (e as Error).message);
  }

  // VDF 経路は uninstalled な appid の name が「appid:XXXXX」 になる。
  // Store API (= keyless) で resolve してキャッシュ + applications にも反映する。
  // ここは await しても OK だが UX のため snapshot insert を先に返したいので fire-and-forget。
  void resolveUnresolvedSteamApps(db).catch((e) => {
    console.warn('[activity] steam app resolve failed:', (e as Error).message);
  });

  return { source, count: games.length };
}

// ── Steam Store API で appid → name 解決 ───────────────────────────────
//
// 動作:
//   1. steam_activity に存在するが steam_apps_cache が無い (= 未解決) appid を抽出
//   2. 1 つずつ Store API を叩く (rate-limit 配慮で 600ms 間隔)
//   3. 結果を steam_apps_cache に upsert
//   4. 同時に applications テーブルにも `steam:<appid>` の row を作る
//      (= ゲームリスト / アプリ一覧から横断的に見えるように)
//
// 1 回の呼び出しで最大 RESOLVE_BATCH_LIMIT 件まで処理する。

const RESOLVE_BATCH_LIMIT = 30;
const RESOLVE_INTERVAL_MS = 600;

export async function resolveUnresolvedSteamApps(db: Db): Promise<{ resolved: number; notFound: number; errors: number }> {
  const appids = listStaleAppidsFromActivity(db, RESOLVE_BATCH_LIMIT);
  if (appids.length === 0) return { resolved: 0, notFound: 0, errors: 0 };

  let resolved = 0;
  let notFound = 0;
  let errors = 0;

  for (let i = 0; i < appids.length; i++) {
    const appid = appids[i]!;
    const r = await fetchAppDetails(appid);
    if (!r.ok) {
      errors++;
      console.debug(`[activity] steam appdetails ${appid} error:`, r.error);
    } else if (r.notFound) {
      notFound++;
      upsertSteamAppCache(db, appid, { not_found: true });
    } else if (r.details) {
      resolved++;
      upsertSteamAppCache(db, appid, {
        name: r.details.name,
        header_image: r.details.header_image,
        type: r.details.type,
        short_desc: r.details.short_description,
        not_found: false,
      });
      registerSteamApplication(db, appid, r.details.name, r.details.type, r.details.short_description, r.details.header_image);
      // steam_activity 側の name も上書き (= appid:XXXXX → 正式名)
      try {
        db.prepare(`UPDATE steam_activity SET name = ? WHERE appid = ? AND name LIKE 'appid:%'`).run(r.details.name, appid);
      } catch (e) {
        console.debug('[activity] steam_activity name update failed:', (e as Error).message);
      }
    }
    if (i < appids.length - 1) {
      await new Promise((res) => setTimeout(res, RESOLVE_INTERVAL_MS));
    }
  }
  if (resolved || notFound || errors) {
    console.log(`[activity] steam resolve — resolved=${resolved} notFound=${notFound} errors=${errors}`);
  }
  return { resolved, notFound, errors };
}

/** Steam appid を applications テーブルに登録 / 更新する。
 *  process_name には `steam:<appid>` を使う (exe 名と衝突しない) 。
 *  Store API の `type` が game/demo なら kind='game'、 その他は 'other'。 */
function registerSteamApplication(
  db: Db,
  appid: number,
  name: string,
  type: string,
  shortDesc: string | null,
  headerImage: string | null,
): void {
  const processName = `steam:${appid}`;
  const kind = (type === 'game' || type === 'demo') ? 'game' : 'other';
  // 既存行が無ければ pending を作って setApplication で埋める (user_edited=1 は触らない)
  if (!getApplication(db, processName)) {
    insertApplicationPending(db, processName);
  }
  setApplication(db, processName, {
    name,
    kind,
    description: shortDesc,
    icon_url: headerImage,
    status: 'done',
    error: null,
  });
}
