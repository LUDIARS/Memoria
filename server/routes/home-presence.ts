// 帰宅・出発通知の設定 API。 設定画面「🏠 帰宅・出発 / LINE」 が読み書きする。
// 自宅や現在地の座標は返さない (出所・半径・現在 zone・GPS の経過分だけ)。

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings } from '../db.js';
import { requireScope } from '../lib/scoped-access.js';
import { DISCORD_CHANNEL_KINDS } from '../shared/notify-sink.js';
import {
  findRule, loadConfig, loadRules, normalizeConfig, normalizeRules, saveConfig, saveRules,
} from '../home-presence/config.js';
import { resolveHome } from '../home-presence/home.js';
import { readLatestFix } from '../home-presence/latest-fix.js';
import { clearState, loadState } from '../home-presence/state.js';
import { fireRule } from '../home-presence/engine.js';
import { DEFAULT_MESSAGES } from '../home-presence/message.js';

type Db = BetterSqlite3.Database;

export interface HomePresenceRouterDeps { db: Db; }

function registeredCategories(db: Db): string[] {
  try {
    const raw = getAppSettings(db)['task.categories.registered'];
    const a = raw ? JSON.parse(raw) : [];
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function statusView(db: Db, now: number) {
  const home = resolveHome(db);
  const fix = readLatestFix(db);
  return {
    home: home ? { source: home.source, name: home.name, radiusM: home.radiusM } : null,
    zone: loadState(db)?.zone ?? null,
    gpsAgeMin: fix ? Math.max(0, Math.round((now - fix.recordedAt) / 60_000)) : null,
  };
}

export function makeHomePresenceRouter({ db }: HomePresenceRouterDeps): Hono {
  const r = new Hono();
  r.use('/api/home-presence', requireScope('admin'));
  r.use('/api/home-presence/*', requireScope('admin'));

  r.get('/api/home-presence', (c: Context) => c.json({
    config: loadConfig(db),
    rules: loadRules(db),
    status: statusView(db, Date.now()),
    choices: { categories: registeredCategories(db), channels: DISCORD_CHANNEL_KINDS, defaultMessages: DEFAULT_MESSAGES },
  }));

  // config と rules を保存 (UI で編集して丸ごと PUT)。 片方だけ送られたら他方は据え置き。
  r.put('/api/home-presence', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { config?: unknown; rules?: unknown };
    if (body.config !== undefined) {
      const wasEnabled = loadConfig(db).enabled;
      const next = normalizeConfig(body.config);
      // OFF の間の古い状態と比べて誤発火しないよう、 ON にした時点で基準を取り直す
      if (!wasEnabled && next.enabled) clearState(db);
      saveConfig(db, next);
    }
    if (body.rules !== undefined) saveRules(db, normalizeRules(body.rules));
    return c.json({ ok: true, config: loadConfig(db), rules: loadRules(db) });
  });

  // rule を即時送信 (動作確認)。 該当 0 件でも送る。
  r.post('/api/home-presence/rules/:id/test', async (c: Context) => {
    const rule = findRule(db, c.req.param('id') || '');
    if (!rule) return c.json({ ok: false, reason: 'not_found' }, 404);
    if (!rule.destinations.length) return c.json({ ok: false, reason: '送り先がありません' }, 409);
    const res = await fireRule(db, rule, rule.event, { force: true });
    return c.json({
      ok: res.sent,
      count: res.taskCount,
      results: res.results.map((x) => ({ kind: x.destination.kind, ok: x.ok, reason: x.reason ?? null })),
    }, res.sent ? 200 : 409);
  });

  return r;
}
