// /api/personality-export/* — Voluptas連携の設定・トークン管理 (Access 保護の管理画面用)
// /api/external/personality-features — Bearerトークンで保護された、Voluptas向けの読み取り専用公開口。
//
// 個人データはローカルに閉じる方針 ([[project_personal_data_rule]]) の唯一の例外。
// 送信するのは tasks(category/kind/status)・diary_entries(work_minutes)・
// activity_events(kind/occurred_at) から計算した集計特徴量のみで、本文 (title/details/
// work_content/notes/activity content) は一切ネットワークに乗せない
// (server/personality-export/features.ts のnarrow input型がその境界を強制する)。

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { setAppSettings } from '../db.js';
import { privacySettings } from '../lib/privacy.js';
import { issueShareToken, revokeShareToken, getShareTokenStatus, verifyShareToken } from '../personality-export/share-token.js';
import { computePersonalityFeatures } from '../personality-export/features.js';
import {
  gatherPersonalityFeatureInputs,
  PERSONALITY_SAMPLE_WINDOW_DAYS,
} from '../personality-export/feature-inputs.js';
import { isSameMachineRequest } from '../lib/local-request.js';

type Db = BetterSqlite3.Database;

export interface PersonalityExportRouterDeps { db: Db }

export function makePersonalityExportRouter(deps: PersonalityExportRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  // ── Access 保護の管理画面 ────────────────────────────────────────────────
  // Accept the configured Access host, but retain local-peer and same-origin
  // checks so direct LAN access and cross-site mutations stay blocked.
  r.use('/api/personality-export/*', async (c, next) => {
    if (!isSameMachineRequest(c)) {
      return c.json({ error: 'same-machine access required' }, 403);
    }
    await next();
  });

  r.get('/api/personality-export/status', (c: Context) => {
    const priv = privacySettings(db);
    const token = getShareTokenStatus(db);
    return c.json({ enabled: priv.external_share_voluptas_personality_enabled, ...token });
  });

  r.patch('/api/personality-export/settings', async (c: Context) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }
    const enabled = (body as { enabled: boolean }).enabled;
    setAppSettings(db, { 'features.external_share.voluptas_personality.enabled': enabled ? '1' : '0' });
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
    const inputs = gatherPersonalityFeatureInputs(db, now);
    const features = computePersonalityFeatures(inputs, {
      sampleWindowDays: PERSONALITY_SAMPLE_WINDOW_DAYS,
      now: () => now,
    });
    return c.json(features);
  });

  return r;
}
