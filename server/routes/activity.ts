// /api/activity/* — PC アプリ使用統計 + Steam 活動。
// Spec: spec/api/activity.md (未作成、 本 PR で feature 投入)

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';
import { privacySettings } from '../lib/privacy.js';
import {
  sampleAppOnce, sampleSteamOnce, configureActivitySamplers,
} from '../lib/activity-sampler.js';

type Db = BetterSqlite3.Database;

interface AppDayRow {
  process_name: string;
  total_sec: number;
  samples: number;
  last_at: string;
}
interface SteamDayRow {
  appid: number;
  name: string;
  playtime_2weeks_min: number | null;
  playtime_forever_min: number | null;
  img_icon_url: string | null;
  sampled_at: string;
}

export interface ActivityRouterDeps { db: Db }

export function makeActivityRouter(deps: ActivityRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  // ── PC アプリ使用統計 ─────────────────────────────────────────────
  // GET /api/activity/apps?date=YYYY-MM-DD
  //   - process_name 別の合計サンプル時間 (= samples * sample_interval_sec)
  //   - 上位 50 件、 多い順
  r.get('/api/activity/apps', (c: Context) => {
    const dateRaw = c.req.query('date');
    const date = (typeof dateRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw))
      ? dateRaw
      : new Date().toISOString().slice(0, 10);
    const rows = db.prepare(`
      SELECT process_name,
             SUM(sample_interval_sec) AS total_sec,
             COUNT(*)                  AS samples,
             MAX(sampled_at)           AS last_at
      FROM app_samples
      WHERE date(sampled_at, 'localtime') = ?
      GROUP BY process_name
      ORDER BY total_sec DESC
      LIMIT 50
    `).all(date) as AppDayRow[];
    return c.json({ date, items: rows });
  });

  // GET /api/activity/apps/recent?limit=50
  //   - 直近の raw サンプル (window_title 付き)
  r.get('/api/activity/apps/recent', (c: Context) => {
    const limit = Math.max(1, Math.min(200, Number(c.req.query('limit') || 50)));
    const rows = db.prepare(`
      SELECT id, sampled_at, process_name, window_title
      FROM app_samples
      ORDER BY sampled_at DESC
      LIMIT ?
    `).all(limit);
    return c.json({ items: rows });
  });

  // POST /api/activity/apps/sample-now — デバッグ用に手動サンプル
  r.post('/api/activity/apps/sample-now', async (c: Context) => {
    const settings = getAppSettings(db);
    const sec = Math.max(5, Number(settings['activity.app_sample_sec'] ?? 30));
    await sampleAppOnce(db, sec);
    return c.json({ ok: true });
  });

  // ── Steam ─────────────────────────────────────────────────────────
  // GET /api/activity/steam/recent — 直近スナップショットを appid 単位で 1 つに
  //   uniq して返す (= 最新の playtime_2weeks_min 順)
  r.get('/api/activity/steam/recent', (c: Context) => {
    const rows = db.prepare(`
      SELECT appid, name, playtime_2weeks_min, playtime_forever_min,
             img_icon_url, sampled_at
      FROM steam_activity
      WHERE id IN (
        SELECT MAX(id) FROM steam_activity GROUP BY appid
      )
      ORDER BY COALESCE(playtime_2weeks_min, 0) DESC, sampled_at DESC
      LIMIT 50
    `).all() as SteamDayRow[];
    return c.json({ items: rows });
  });

  // POST /api/activity/steam/sample-now — 手動 snapshot 取得
  r.post('/api/activity/steam/sample-now', async (c: Context) => {
    const r2 = await sampleSteamOnce(db);
    return c.json(r2);
  });

  // ── 設定 ──────────────────────────────────────────────────────────
  // PATCH /api/activity/settings  — feature flag + 周期 + Steam credentials
  // body: {
  //   app_sampling?: boolean,
  //   app_sample_sec?: number,
  //   steam_enabled?: boolean,
  //   steam_interval_min?: number,
  //   steam_api_key?: string,
  //   steam_id?: string,
  // }
  r.patch('/api/activity/settings', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const patch: Record<string, string> = {};
    if (typeof body.app_sampling === 'boolean') patch['features.activity.app_sampling.enabled'] = body.app_sampling ? '1' : '0';
    if (typeof body.steam_enabled === 'boolean') patch['features.activity.steam.enabled'] = body.steam_enabled ? '1' : '0';
    if (typeof body.app_sample_sec === 'number' && Number.isFinite(body.app_sample_sec)) {
      patch['activity.app_sample_sec'] = String(Math.max(5, Math.min(600, Math.floor(body.app_sample_sec))));
    }
    if (typeof body.steam_interval_min === 'number' && Number.isFinite(body.steam_interval_min)) {
      patch['activity.steam_interval_min'] = String(Math.max(5, Math.min(1440, Math.floor(body.steam_interval_min))));
    }
    if (typeof body.steam_api_key === 'string') patch['steam.web_api_key'] = body.steam_api_key.trim();
    if (typeof body.steam_id === 'string') patch['steam.steam_id'] = body.steam_id.trim();
    if (Object.keys(patch).length > 0) {
      setAppSettings(db, patch);
      configureActivitySamplers(db);
    }
    // 現在の設定を返す (api_key は masked)
    const s = getAppSettings(db);
    const priv = privacySettings(db);
    return c.json({
      app_sampling: priv.activity_app_sampling_enabled,
      steam_enabled: priv.activity_steam_enabled,
      app_sample_sec: Number(s['activity.app_sample_sec'] ?? 30),
      steam_interval_min: Number(s['activity.steam_interval_min'] ?? 60),
      steam_api_key_set: !!(s['steam.web_api_key'] || '').trim(),
      steam_id: (s['steam.steam_id'] || '').trim(),
    });
  });

  r.get('/api/activity/settings', (c: Context) => {
    const s = getAppSettings(db);
    const priv = privacySettings(db);
    return c.json({
      app_sampling: priv.activity_app_sampling_enabled,
      steam_enabled: priv.activity_steam_enabled,
      app_sample_sec: Number(s['activity.app_sample_sec'] ?? 30),
      steam_interval_min: Number(s['activity.steam_interval_min'] ?? 60),
      steam_api_key_set: !!(s['steam.web_api_key'] || '').trim(),
      steam_id: (s['steam.steam_id'] || '').trim(),
    });
  });

  return r;
}
