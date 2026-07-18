// /api/personality-export/* — Voluptas連携の設定・トークン管理 (ローカル管理画面用)
// /api/external/personality-features — Bearerトークンで保護された、Voluptas向けの読み取り専用公開口。
//
// 個人データはローカルに閉じる方針 ([[project_personal_data_rule]]) の唯一の例外。
// 送信するのは tasks(category/kind/status)・diary_entries(work_minutes)・
// activity_events(kind/occurred_at) から計算した集計特徴量のみで、本文 (title/details/
// work_content/notes/activity content) は一切ネットワークに乗せない
// (server/personality-export/features.ts のnarrow input型がその境界を強制する)。

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { listTasks, listDiariesInRange, listActivityEvents, setAppSettings } from '../db.js';
import { privacySettings } from '../lib/privacy.js';
import { issueShareToken, revokeShareToken, getShareTokenStatus, verifyShareToken } from '../personality-export/share-token.js';
import {
  computePersonalityFeatures,
  type TaskFeatureInput,
  type DiaryFeatureInput,
  type ActivityFeatureInput,
} from '../personality-export/features.js';

type Db = BetterSqlite3.Database;

const SAMPLE_WINDOW_DAYS = 90;
const MAX_TASK_SAMPLE = 5000;
const MAX_ACTIVITY_SAMPLE = 2000;

export interface PersonalityExportRouterDeps { db: Db }

function windowStartEnd(now: Date, days: number): { start: Date; end: Date } {
  const end = now;
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, end };
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function gatherFeatureInputs(db: Db, now: Date): { tasks: TaskFeatureInput[]; diaries: DiaryFeatureInput[]; activities: ActivityFeatureInput[] } {
  const { start, end } = windowStartEnd(now, SAMPLE_WINDOW_DAYS);

  const tasks: TaskFeatureInput[] = listTasks(db, { kind: 'all', limit: MAX_TASK_SAMPLE })
    .filter((t) => new Date(t.created_at).getTime() >= start.getTime())
    .map((t) => ({ status: t.status, kind: t.kind, created_at: t.created_at, due_at: t.due_at, category: t.category }));

  const diaries: DiaryFeatureInput[] = listDiariesInRange(db, { start: formatDate(start), end: formatDate(end) })
    .map((d) => ({ date: d.date, work_minutes: d.work_minutes }));

  const activities: ActivityFeatureInput[] = listActivityEvents(db, { limit: MAX_ACTIVITY_SAMPLE })
    .filter((a) => new Date(a.occurred_at).getTime() >= start.getTime())
    .map((a) => ({ kind: a.kind, occurred_at: a.occurred_at }));

  return { tasks, diaries, activities };
}

export function makePersonalityExportRouter(deps: PersonalityExportRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  // ── ローカル管理 (Memoria自身のUIから叩く。他ルートと同様に追加認証なし) ──────────

  r.get('/api/personality-export/status', (c: Context) => {
    const priv = privacySettings(db);
    const token = getShareTokenStatus(db);
    return c.json({ enabled: priv.external_share_voluptas_personality_enabled, ...token });
  });

  r.patch('/api/personality-export/settings', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.enabled === 'boolean') {
      setAppSettings(db, { 'features.external_share.voluptas_personality.enabled': body.enabled ? '1' : '0' });
    }
    const priv = privacySettings(db);
    const token = getShareTokenStatus(db);
    return c.json({ enabled: priv.external_share_voluptas_personality_enabled, ...token });
  });

  // POST /api/personality-export/token — 新規発行 (既存トークンは上書きで失効)。
  // 平文トークンはこのレスポンスでのみ返し、以後は再取得不可 (再発行のみ)。
  r.post('/api/personality-export/token', (c: Context) => {
    const priv = privacySettings(db);
    if (!priv.external_share_voluptas_personality_enabled) {
      return c.json({ error: 'external_share_voluptas_personality is disabled' }, 400);
    }
    const issued = issueShareToken(db);
    return c.json(issued);
  });

  r.delete('/api/personality-export/token', (c: Context) => {
    revokeShareToken(db);
    return c.json({ ok: true });
  });

  // ── Voluptas向け公開口 (Bearerトークン検証。存在を匂わせないため失敗は一律404) ──

  r.get('/api/external/personality-features', (c: Context) => {
    const priv = privacySettings(db);
    if (!priv.external_share_voluptas_personality_enabled) {
      return c.json({ error: 'not found' }, 404);
    }
    const auth = c.req.header('Authorization') || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!verifyShareToken(db, presented)) {
      return c.json({ error: 'not found' }, 404);
    }

    const now = new Date();
    const inputs = gatherFeatureInputs(db, now);
    const features = computePersonalityFeatures(inputs, { sampleWindowDays: SAMPLE_WINDOW_DAYS, now: () => now });
    return c.json(features);
  });

  return r;
}
