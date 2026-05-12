// /api/activity/* — PC アプリ使用統計 + Steam 活動。
// Spec: spec/api/activity.md (未作成、 本 PR で feature 投入)

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  getAppSettings, setAppSettings,
  listApplications, getApplication, setApplication, updateApplicationUser,
  insertApplicationPending,
} from '../db.js';
import { privacySettings } from '../lib/privacy.js';
import {
  sampleAppOnce, sampleSteamOnce, configureActivitySamplers,
} from '../lib/activity-sampler.js';
import { classifyApplication } from '../app-catalog.js';

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

  // ── applications カタログ (process_name → AI 分類) ────────────────
  // GET /api/activity/applications  - 全件
  r.get('/api/activity/applications', (c: Context) => {
    const items = listApplications(db, { limit: 1000 });
    return c.json({ items });
  });

  // PATCH /api/activity/applications/:processName — ユーザ手動編集
  r.patch('/api/activity/applications/:processName', async (c: Context) => {
    const processName = decodeURIComponent(c.req.param('processName') ?? '');
    if (!processName) return c.json({ error: 'processName required' }, 400);
    if (!getApplication(db, processName)) {
      // pending を作成して update_user で上書き
      insertApplicationPending(db, processName);
    }
    const body = await c.req.json().catch(() => ({})) as { name?: unknown; kind?: unknown; description?: unknown };
    updateApplicationUser(db, processName, {
      name: typeof body.name === 'string' ? body.name : undefined,
      kind: typeof body.kind === 'string' ? body.kind : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
    });
    return c.json({ application: getApplication(db, processName) });
  });

  // POST /api/activity/applications/:processName/classify-now — 手動 trigger
  r.post('/api/activity/applications/:processName/classify-now', async (c: Context) => {
    const processName = decodeURIComponent(c.req.param('processName') ?? '');
    if (!processName) return c.json({ error: 'processName required' }, 400);
    insertApplicationPending(db, processName);
    try {
      const result = await classifyApplication({ processName, platform: process.platform });
      setApplication(db, processName, {
        name: result.name,
        kind: result.kind,
        description: result.description,
        status: 'done',
        error: null,
      });
      return c.json({ application: getApplication(db, processName) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setApplication(db, processName, { status: 'error', error: msg.slice(0, 500) });
      return c.json({ application: getApplication(db, processName), error: msg }, 502);
    }
  });

  // ── 🎮 ゲームログ ─────────────────────────────────────────────
  // GET /api/activity/games?date=YYYY-MM-DD
  //   Steam スナップショット (source=steam) + applications.kind='game' な
  //   app_samples (source=app) を時系列マージして返す。
  interface GameLogRow {
    source: 'steam' | 'app';
    occurred_at: string;
    title: string;       // 表示名
    duration_min?: number;
    detail?: string;
    appid?: number;
    img_icon_url?: string | null;
  }
  r.get('/api/activity/games', (c: Context) => {
    const dateRaw = c.req.query('date');
    const date = (typeof dateRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw))
      ? dateRaw
      : new Date().toISOString().slice(0, 10);

    // 1) Steam — 当日に取られた snapshot を時系列で
    const steamRows = db.prepare(`
      SELECT sampled_at, appid, name, playtime_2weeks_min, playtime_forever_min, img_icon_url
      FROM steam_activity
      WHERE date(sampled_at, 'localtime') = ?
      ORDER BY sampled_at ASC
    `).all(date) as Array<{
      sampled_at: string; appid: number; name: string;
      playtime_2weeks_min: number | null; playtime_forever_min: number | null;
      img_icon_url: string | null;
    }>;

    // 同じ appid 内で snapshot 間の playtime_forever_min 差分 (= その日の追加プレイ時間)
    const byApp = new Map<number, typeof steamRows>();
    for (const row of steamRows) {
      if (!byApp.has(row.appid)) byApp.set(row.appid, []);
      byApp.get(row.appid)!.push(row);
    }
    const games: GameLogRow[] = [];
    for (const [appid, rows] of byApp) {
      // この appid の当日の playtime 増分 = (最新 - 最古) の forever_min 差
      const first = rows[0]!;
      const last = rows[rows.length - 1]!;
      const delta = (last.playtime_forever_min ?? 0) - (first.playtime_forever_min ?? 0);
      if (delta > 0) {
        games.push({
          source: 'steam',
          occurred_at: last.sampled_at,
          title: last.name,
          duration_min: delta,
          detail: `Steam (${appid})`,
          appid,
          img_icon_url: last.img_icon_url,
        });
      } else {
        // snapshot 1 件のみ / 増分 0: 「観測されているがプレイ時間なし」 として
        // playtime_2weeks_min が大きい (= 最近遊んでた) なら参考表示
        const p2 = last.playtime_2weeks_min ?? 0;
        if (p2 > 0) {
          games.push({
            source: 'steam',
            occurred_at: last.sampled_at,
            title: last.name,
            duration_min: undefined,
            detail: `Steam (${appid}) — 直近 2 週: ${p2}分`,
            appid,
            img_icon_url: last.img_icon_url,
          });
        }
      }
    }

    // 2) applications.kind='game' な process_name の当日サンプルを集計
    const appGameRows = db.prepare(`
      SELECT s.process_name,
             SUM(s.sample_interval_sec) AS total_sec,
             MAX(s.sampled_at)           AS last_at,
             a.name AS app_name
      FROM app_samples s
      JOIN applications a ON a.process_name = s.process_name
      WHERE date(s.sampled_at, 'localtime') = ?
        AND a.kind = 'game'
        AND a.status = 'done'
      GROUP BY s.process_name
      ORDER BY total_sec DESC
    `).all(date) as Array<{ process_name: string; total_sec: number; last_at: string; app_name: string | null }>;
    for (const row of appGameRows) {
      games.push({
        source: 'app',
        occurred_at: row.last_at,
        title: row.app_name || row.process_name,
        duration_min: Math.round(row.total_sec / 60),
        detail: row.process_name,
      });
    }

    // 時系列 (occurred_at) 降順で並べ替え
    games.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
    return c.json({ date, items: games });
  });

  // GET /api/activity/work-time?date=YYYY-MM-DD
  //   applications.kind='work' な process_name の当日合計サンプル時間。
  r.get('/api/activity/work-time', (c: Context) => {
    const dateRaw = c.req.query('date');
    const date = (typeof dateRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw))
      ? dateRaw
      : new Date().toISOString().slice(0, 10);
    const row = db.prepare(`
      SELECT COALESCE(SUM(s.sample_interval_sec), 0) AS total_sec,
             COUNT(*)                                AS samples
      FROM app_samples s
      JOIN applications a ON a.process_name = s.process_name
      WHERE date(s.sampled_at, 'localtime') = ?
        AND a.kind = 'work'
        AND a.status = 'done'
    `).get(date) as { total_sec: number; samples: number };
    // kind 別の内訳も返す (UI でカード分類するため)
    const byKind = db.prepare(`
      SELECT a.kind,
             COALESCE(SUM(s.sample_interval_sec), 0) AS total_sec,
             COUNT(*)                                AS samples
      FROM app_samples s
      JOIN applications a ON a.process_name = s.process_name
      WHERE date(s.sampled_at, 'localtime') = ?
        AND a.status = 'done'
      GROUP BY a.kind
    `).all(date) as Array<{ kind: string; total_sec: number; samples: number }>;
    return c.json({
      date,
      work_total_sec: row.total_sec,
      work_total_min: Math.round(row.total_sec / 60),
      work_samples: row.samples,
      by_kind: byKind,
    });
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
