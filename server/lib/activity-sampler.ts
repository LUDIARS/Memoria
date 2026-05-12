// アプリ活動 + Steam 活動の周期サンプラ。 server 起動時に start() を呼ぶと
// 内部 timer を立ち上げて、 一定間隔で:
//   - 最前面アプリを 1 サンプリング (app_samples へ insert)
//   - Steam Web API or local VDF からプレイ統計を snapshot (steam_activity へ insert)
//
// すべて feature flag (= privacySettings) で OFF にできる。 設定変更時は
// configureActivitySamplers() を呼んで timer を再構成する。

import type BetterSqlite3 from 'better-sqlite3';
import { getForegroundApp } from './app-activity-sampler.js';
import { getRecentlyPlayedGames, type SteamGameSnapshot } from './steam-client.js';
import { getRecentlyPlayedFromVdf } from './steam-vdf.js';
import { getAppSettings } from '../db.js';
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
  return { source, count: games.length };
}
