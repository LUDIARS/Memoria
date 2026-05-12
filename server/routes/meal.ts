// /api/meals* — 食事記録 (写真 + EXIF + GPS から食事内容 / カロリー推定)。
// Spec: spec/api/meal.md

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  insertMeal, getMeal, listMeals, countMeals, updateMeal, deleteMeal,
} from '../db.js';
import { extractPhotoMeta, resolveMealLocation } from '../meals.js';
import { featureEnabled } from '../lib/privacy.js';

type Db = BetterSqlite3.Database;

const MEAL_PHOTO_MAX_BYTES = 12 * 1024 * 1024; // 12 MiB

interface MealAddition {
  name: string;
  calories: number | null;
  added_at: string;
}

const MEAL_ADDITION_NAME_MAX = 200;

function parseAdditions(json: string | null): MealAddition[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr as MealAddition[] : [];
  } catch {
    return [];
  }
}

function randomHex8(): string {
  const buf = new Uint8Array(4);
  globalThis.crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function pickPhotoExt(filename: string | null | undefined, mime: string | null | undefined): string {
  const lower = (filename ?? '').toLowerCase();
  if (lower.endsWith('.png')) return '.png';
  if (lower.endsWith('.heic') || lower.endsWith('.heif')) return '.heic';
  if (lower.endsWith('.webp')) return '.webp';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/heic' || mime === 'image/heif') return '.heic';
  if (mime === 'image/webp') return '.webp';
  return '.jpg';
}

function mimeFromExt(p: string): string {
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.heic') || p.endsWith('.heif')) return 'image/heic';
  if (p.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

export interface MealRouterDeps {
  db: Db;
  mealDir: string;
  enqueueMealVision: (id: number) => void;
  enqueueCalorieEstimate: (mealId: number, additionIdx: number, foodName: string) => void;
}

export function makeMealRouter(deps: MealRouterDeps): Hono {
  const { db, mealDir, enqueueMealVision, enqueueCalorieEstimate } = deps;
  const r = new Hono();

  // POST /api/meals — multipart/form-data
  r.post('/api/meals', async (c: Context) => {
    if (!featureEnabled(db, 'meals_enabled')) return c.json({ error: 'meals are disabled' }, 403);
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: 'multipart/form-data required' }, 400);
    const photo = form.get('photo');
    if (!(photo instanceof File)) return c.json({ error: 'photo (File) required' }, 400);
    if (photo.size === 0) return c.json({ error: 'empty photo' }, 400);
    if (photo.size > MEAL_PHOTO_MAX_BYTES) {
      return c.json({ error: `photo too large (max ${MEAL_PHOTO_MAX_BYTES} bytes)` }, 413);
    }
    const buf = Buffer.from(await photo.arrayBuffer());
    const exif = await extractPhotoMeta(buf);

    const userNote = (form.get('user_note') ?? '').toString().trim() || null;
    const eatenAtRaw = (form.get('eaten_at') ?? '').toString().trim();
    const latRaw = (form.get('lat') ?? '').toString().trim();
    const lonRaw = (form.get('lon') ?? '').toString().trim();
    const manualLat = latRaw ? Number(latRaw) : null;
    const manualLon = lonRaw ? Number(lonRaw) : null;
    const hasManualLatLon =
      typeof manualLat === 'number' && isFinite(manualLat) &&
      typeof manualLon === 'number' && isFinite(manualLon);

    // 食事時刻: 手動 > EXIF > 投稿時刻
    let eatenAt = '';
    // 'post' は DB 型上は無いが、 JS 時代から書き込んでおり Memoria 内では実質
    // 「 explicit 指定なし (now() で埋めた)」 扱い。
    let eatenAtSource = 'manual' as 'manual' | 'exif' | 'post';
    if (eatenAtRaw) {
      const d = new Date(eatenAtRaw);
      if (!isNaN(d.getTime())) {
        eatenAt = d.toISOString();
        eatenAtSource = 'manual';
      }
    }
    if (!eatenAt && exif.capturedAt) {
      eatenAt = exif.capturedAt;
      eatenAtSource = 'exif';
    }
    if (!eatenAt) {
      eatenAt = new Date().toISOString();
      eatenAtSource = 'post';
    }

    const loc = resolveMealLocation(
      db,
      exif,
      eatenAt,
      hasManualLatLon ? { lat: manualLat as number, lon: manualLon as number } : null,
    );

    const ext = pickPhotoExt(photo.name, photo.type);
    const id = insertMeal(db, {
      photo_path: 'placeholder' + ext,
      eaten_at: eatenAt,
      eaten_at_source: eatenAtSource as 'manual' | 'exif' | 'gps' | 'inference',
      lat: loc.lat,
      lon: loc.lon,
      location_label: loc.label,
      location_source: loc.source,
      description: null,
      calories: null,
      items_json: null,
      ai_status: 'pending',
      ai_error: null,
      user_note: userNote,
    });

    // ファイル名は `<id>-<8hex><ext>` 形式 (id は単調増加 PK + 短い乱数 suffix で
    // 万一の衝突 / DB リセット後の id 再利用に備える)。 既存ファイルがあれば
    // suffix を再生成するループでガード。
    let filename = '';
    let fullPath = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const suffix = randomHex8();
      filename = `${id}-${suffix}${ext}`;
      fullPath = join(mealDir, filename);
      if (!existsSync(fullPath)) break;
    }
    if (!filename || existsSync(fullPath)) {
      deleteMeal(db, id);
      return c.json({ error: 'failed to allocate unique photo filename' }, 500);
    }
    try {
      writeFileSync(fullPath, buf);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      deleteMeal(db, id);
      return c.json({ error: `write photo: ${msg}` }, 500);
    }
    updateMeal(db, id, { photo_path: filename });

    // `features.meals.auto_vision` で OFF にできる (写真 + 食事記録は保存されるが
    // LLM 解析はスキップ。 後から「再分析」 ボタンで手動起動可)。
    if (featureEnabled(db, 'meals_auto_vision')) {
      enqueueMealVision(id);
    } else {
      updateMeal(db, id, { ai_status: 'done', ai_error: null });
    }

    const created = getMeal(db, id);
    return c.json({ meal: created }, 201);
  });

  // POST /api/meals/manual — 写真なしで食事を直接登録する (JSON body)
  r.post('/api/meals/manual', async (c: Context) => {
    if (!featureEnabled(db, 'meals_enabled')) return c.json({ error: 'meals are disabled' }, 403);
    const body = await c.req.json().catch(() => null) as
      | { description?: unknown; eaten_at?: unknown; calories?: unknown; lat?: unknown; lon?: unknown; user_note?: unknown }
      | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'json body required' }, 400);
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!description) return c.json({ error: 'description (string) required' }, 400);

    // 食事時刻
    let eatenAt = '';
    let eatenAtSource = 'manual' as 'manual' | 'post';
    if (typeof body.eaten_at === 'string' && body.eaten_at.trim()) {
      const d = new Date(body.eaten_at);
      if (!isNaN(d.getTime())) {
        eatenAt = d.toISOString();
      }
    }
    if (!eatenAt) {
      eatenAt = new Date().toISOString();
      eatenAtSource = 'post';
    }

    // 場所: 手動 → GPS 軌跡 → なし
    const manualLat = (typeof body.lat === 'number' && isFinite(body.lat)) ? body.lat : null;
    const manualLon = (typeof body.lon === 'number' && isFinite(body.lon)) ? body.lon : null;
    const hasManualLatLon = manualLat != null && manualLon != null;
    const loc = resolveMealLocation(
      db,
      { capturedAt: null, lat: null, lon: null }, // EXIF なし
      eatenAt,
      hasManualLatLon ? { lat: manualLat, lon: manualLon } : null,
    );

    // calories: 数値 / 文字列 / 未指定 (= 背景推定)
    let calories: number | null = null;
    if (typeof body.calories === 'number' && isFinite(body.calories)) {
      calories = Math.round(body.calories);
    } else if (typeof body.calories === 'string' && body.calories.trim() !== '') {
      const n = Number(body.calories);
      if (isFinite(n)) calories = Math.round(n);
    }

    const id = insertMeal(db, {
      photo_path: '', // 写真なしマーカー
      eaten_at: eatenAt,
      eaten_at_source: eatenAtSource as 'manual' | 'exif' | 'gps' | 'inference',
      lat: loc.lat,
      lon: loc.lon,
      location_label: loc.label,
      location_source: loc.source,
      description,
      calories,
      items_json: null,
      ai_status: calories != null ? 'done' : 'pending',
      ai_error: null,
      user_note: typeof body.user_note === 'string' ? (body.user_note.trim() || null) : null,
    });

    // calories 未指定なら LLM で背景推定 (description を食品名として渡す)。
    // `features.meals.auto_vision` 連動 — OFF だと calories は null のまま (= 「— kcal」 表示)。
    if (calories == null && featureEnabled(db, 'meals_auto_vision')) {
      enqueueCalorieEstimate(id, -1, description);
    }

    const created = getMeal(db, id);
    return c.json({ meal: created }, 201);
  });

  r.get('/api/meals', (c: Context) => {
    if (!featureEnabled(db, 'meals_visible')) return c.json({ meals: [], total: 0 });
    const from = c.req.query('from') || undefined;
    const to = c.req.query('to') || undefined;
    const limit = Math.min(Number(c.req.query('limit') || 100), 500);
    const offset = Math.max(Number(c.req.query('offset') || 0), 0);
    const meals = listMeals(db, { from, to, limit, offset });
    const total = countMeals(db, { from, to });
    return c.json({ meals, total });
  });

  r.get('/api/meals/:id', (c: Context) => {
    if (!featureEnabled(db, 'meals_visible')) return c.json({ error: 'meals are hidden' }, 403);
    const id = Number(c.req.param('id'));
    const meal = getMeal(db, id);
    if (!meal) return c.json({ error: 'not found' }, 404);
    return c.json({ meal });
  });

  r.get('/api/meals/:id/photo', (c: Context) => {
    if (!featureEnabled(db, 'meals_visible')) return c.json({ error: 'meals are hidden' }, 403);
    const id = Number(c.req.param('id'));
    const meal = getMeal(db, id);
    if (!meal) return c.json({ error: 'not found' }, 404);
    // 写真なし meal (photo_path === '') は 404 を返し、 frontend は
    // プレースホルダ画像を表示する。
    if (!meal.photo_path) return c.json({ error: 'no photo' }, 404);
    const fullPath = join(mealDir, meal.photo_path);
    if (!existsSync(fullPath)) return c.json({ error: 'photo missing' }, 404);
    const buf = readFileSync(fullPath);
    return new Response(buf, {
      headers: {
        'Content-Type': mimeFromExt(meal.photo_path),
        'Cache-Control': 'private, max-age=86400',
      },
    });
  });

  r.patch('/api/meals/:id', async (c: Context) => {
    if (!featureEnabled(db, 'meals_enabled')) return c.json({ error: 'meals are disabled' }, 403);
    const id = Number(c.req.param('id'));
    const meal = getMeal(db, id);
    if (!meal) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => null) as
      | {
          user_note?: unknown; user_corrected_description?: unknown; user_corrected_calories?: unknown;
          eaten_at?: unknown; lat?: unknown; lon?: unknown;
        }
      | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'json body required' }, 400);

    const patch: Record<string, unknown> = {};
    if (typeof body.user_note === 'string') patch.user_note = body.user_note.trim() || null;
    if (typeof body.user_corrected_description === 'string') {
      patch.user_corrected_description = body.user_corrected_description.trim() || null;
    }
    if (body.user_corrected_calories === null) {
      patch.user_corrected_calories = null;
    } else if (typeof body.user_corrected_calories === 'number' && isFinite(body.user_corrected_calories)) {
      patch.user_corrected_calories = Math.round(body.user_corrected_calories);
    }
    if (typeof body.eaten_at === 'string' && body.eaten_at.trim()) {
      const d = new Date(body.eaten_at);
      if (!isNaN(d.getTime())) {
        patch.eaten_at = d.toISOString();
        patch.eaten_at_source = 'manual';
      }
    }
    if (body.lat === null && body.lon === null) {
      patch.lat = null;
      patch.lon = null;
      patch.location_source = 'none';
      patch.location_label = null;
    } else if (
      typeof body.lat === 'number' && isFinite(body.lat) &&
      typeof body.lon === 'number' && isFinite(body.lon)
    ) {
      patch.lat = body.lat;
      patch.lon = body.lon;
      patch.location_source = 'manual';
      patch.location_label = '手動指定';
    }

    if (Object.keys(patch).length > 0) updateMeal(db, id, patch);

    // description が変わって user_corrected_calories を null に戻したケースは
    // 「内容が変わったのでカロリー再推定して」 という合図。 LLM で背景推定する。
    // `features.meals.auto_vision` で OFF にできる。
    const updated = getMeal(db, id);
    const descChanged = patch.user_corrected_description !== undefined &&
      patch.user_corrected_description !== meal.user_corrected_description;
    const calsCleared = patch.user_corrected_calories === null;
    if (descChanged && calsCleared && featureEnabled(db, 'meals_auto_vision')) {
      const desc = (updated?.user_corrected_description as string | null) || updated?.description || '';
      if (desc) enqueueCalorieEstimate(id, -1, desc);
    }
    return c.json({ meal: updated });
  });

  r.delete('/api/meals/:id', (c: Context) => {
    if (!featureEnabled(db, 'meals_enabled')) return c.json({ error: 'meals are disabled' }, 403);
    const id = Number(c.req.param('id'));
    const meal = getMeal(db, id);
    if (!meal) return c.json({ error: 'not found' }, 404);
    if (meal.photo_path) {
      try {
        const fullPath = join(mealDir, meal.photo_path);
        if (existsSync(fullPath)) unlinkSync(fullPath);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[meal#${id}] failed to delete photo: ${msg}`);
      }
    }
    deleteMeal(db, id);
    return c.json({ ok: true });
  });

  r.post('/api/meals/:id/reanalyze', (c: Context) => {
    if (!featureEnabled(db, 'meals_enabled')) return c.json({ error: 'meals are disabled' }, 403);
    const id = Number(c.req.param('id'));
    const meal = getMeal(db, id);
    if (!meal) return c.json({ error: 'not found' }, 404);
    updateMeal(db, id, { ai_status: 'pending', ai_error: null });
    enqueueMealVision(id);
    return c.json({ meal: getMeal(db, id), queued: true });
  });

  // ---- meals: 追加で食べた項目 (additions) ---------------------------------
  //
  // 既存 meal レコードに「あとから食べたもの」 を追記する。

  r.post('/api/meals/:id/additions', async (c: Context) => {
    if (!featureEnabled(db, 'meals_enabled')) return c.json({ error: 'meals are disabled' }, 403);
    const id = Number(c.req.param('id'));
    const meal = getMeal(db, id);
    if (!meal) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => null) as
      | { name?: unknown; calories?: unknown; added_at?: unknown }
      | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'json body required' }, 400);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ error: 'name (string) required' }, 400);
    if (name.length > MEAL_ADDITION_NAME_MAX) {
      return c.json({ error: `name too long (max ${MEAL_ADDITION_NAME_MAX})` }, 400);
    }
    let calories: number | null = null;
    if (body.calories === null) {
      calories = null;
    } else if (typeof body.calories === 'number' && isFinite(body.calories)) {
      calories = Math.round(body.calories);
    } else if (typeof body.calories === 'string' && body.calories.trim() !== '') {
      const n = Number(body.calories);
      if (isFinite(n)) calories = Math.round(n);
    }
    const addedAt = (typeof body.added_at === 'string' && body.added_at.trim())
      ? (() => { const d = new Date(body.added_at as string); return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(); })()
      : new Date().toISOString();

    const additions = parseAdditions(meal.additions_json);
    const newIdx = additions.length;
    additions.push({ name, calories, added_at: addedAt });
    updateMeal(db, id, { additions_json: JSON.stringify(additions) });

    // calories 未指定なら背景で LLM 推定して非同期に書き戻す。
    // `features.meals.auto_vision` で OFF にできる (= 「— kcal」 のまま手動入力待ち)。
    if (calories == null && featureEnabled(db, 'meals_auto_vision')) {
      enqueueCalorieEstimate(id, newIdx, name);
    }
    return c.json({ meal: getMeal(db, id) });
  });

  r.patch('/api/meals/:id/additions/:idx', async (c: Context) => {
    if (!featureEnabled(db, 'meals_enabled')) return c.json({ error: 'meals are disabled' }, 403);
    const id = Number(c.req.param('id'));
    const idx = Number(c.req.param('idx'));
    const meal = getMeal(db, id);
    if (!meal) return c.json({ error: 'not found' }, 404);
    const additions = parseAdditions(meal.additions_json);
    if (!Number.isInteger(idx) || idx < 0 || idx >= additions.length) {
      return c.json({ error: 'index out of range' }, 400);
    }
    const body = await c.req.json().catch(() => null) as
      | { name?: unknown; calories?: unknown; added_at?: unknown }
      | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'json body required' }, 400);
    const cur = additions[idx];
    if (typeof body.name === 'string') {
      const nm = body.name.trim();
      if (nm) cur.name = nm.slice(0, MEAL_ADDITION_NAME_MAX);
    }
    if (body.calories === null) {
      cur.calories = null;
    } else if (typeof body.calories === 'number' && isFinite(body.calories)) {
      cur.calories = Math.round(body.calories);
    } else if (typeof body.calories === 'string' && body.calories.trim() !== '') {
      const n = Number(body.calories);
      if (isFinite(n)) cur.calories = Math.round(n);
    }
    if (typeof body.added_at === 'string' && body.added_at.trim()) {
      const d = new Date(body.added_at);
      if (!isNaN(d.getTime())) cur.added_at = d.toISOString();
    }
    updateMeal(db, id, { additions_json: JSON.stringify(additions) });
    return c.json({ meal: getMeal(db, id) });
  });

  r.delete('/api/meals/:id/additions/:idx', (c: Context) => {
    if (!featureEnabled(db, 'meals_enabled')) return c.json({ error: 'meals are disabled' }, 403);
    const id = Number(c.req.param('id'));
    const idx = Number(c.req.param('idx'));
    const meal = getMeal(db, id);
    if (!meal) return c.json({ error: 'not found' }, 404);
    const additions = parseAdditions(meal.additions_json);
    if (!Number.isInteger(idx) || idx < 0 || idx >= additions.length) {
      return c.json({ error: 'index out of range' }, 400);
    }
    additions.splice(idx, 1);
    updateMeal(db, id, { additions_json: additions.length > 0 ? JSON.stringify(additions) : null });
    return c.json({ meal: getMeal(db, id) });
  });

  return r;
}
