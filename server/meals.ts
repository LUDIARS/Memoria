// 食事記録の補助モジュール
//
// - EXIF パース (時刻 / GPS) — exifr ライブラリ
// - GPS 軌跡からの後付け推定
// - 食事内容 / カロリー推定 — `runLlm({ task: 'meal_vision' })` 経由

import exifr from 'exifr';
import type BetterSqlite3 from 'better-sqlite3';
import { findNearestGpsLocation } from './db.js';
import { runLlm } from './llm.js';

type Db = BetterSqlite3.Database;

export interface PhotoMeta {
  capturedAt: string | null;
  lat: number | null;
  lon: number | null;
}

export interface MealLocation {
  lat: number | null;
  lon: number | null;
  source: 'manual' | 'exif' | 'gps_track' | 'none';
  label: string | null;
}

export interface MealNutrients {
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  fiber_g: number | null;
  sugar_g: number | null;
  sodium_mg: number | null;
}

export interface VisionResult {
  description: string;
  calories: number | null;
  items: { name: string; calories: number | null }[];
  nutrients: MealNutrients | null;
}

export interface CalorieResult {
  calories: number | null;
  serving: string;
  confidence: 'high' | 'medium' | 'low';
  nutrients?: MealNutrients | null;
}

/** 画像バッファから EXIF を抽出する。 失敗しても throw せず空 meta を返す。 */
export async function extractPhotoMeta(buf: Buffer): Promise<PhotoMeta> {
  try {
    // exifr の型定義は ifd0/tiff の boolean を素直に受けないため、 options を
    // unknown 経由で渡す。 ランタイム挙動は変わらず、 取れるフィールドだけ拾う。
    const exifrOpts: unknown = {
      tiff: true,
      ifd0: true,
      exif: true,
      gps: true,
      pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'latitude', 'longitude'],
    };
    const parseFn = exifr.parse as (input: Buffer, opts?: unknown) =>
      Promise<{ DateTimeOriginal?: Date; CreateDate?: Date; ModifyDate?: Date; latitude?: number; longitude?: number } | null>;
    const data = await parseFn(buf, exifrOpts);
    if (!data) return { capturedAt: null, lat: null, lon: null };
    let captured: Date | null = null;
    for (const k of ['DateTimeOriginal', 'CreateDate', 'ModifyDate'] as const) {
      const v = data[k];
      if (v instanceof Date && !isNaN(v.getTime())) {
        captured = v;
        break;
      }
    }
    const lat = typeof data.latitude === 'number' && isFinite(data.latitude) ? data.latitude : null;
    const lon = typeof data.longitude === 'number' && isFinite(data.longitude) ? data.longitude : null;
    return {
      capturedAt: captured ? captured.toISOString() : null,
      lat,
      lon,
    };
  } catch {
    return { capturedAt: null, lat: null, lon: null };
  }
}

/**
 * 場所を以下の優先順位で解決する:
 *   1. 手動 (caller が manual={lat,lon} で渡した場合)
 *   2. EXIF GPS (写真メタデータ)
 *   3. 既存 gps_locations から食事時刻に最も近い点 (±5 分)
 *   4. なし
 */
export function resolveMealLocation(
  db: Db,
  exif: PhotoMeta,
  eatenAt: string,
  manual?: { lat?: number; lon?: number } | null,
): MealLocation {
  if (manual && typeof manual.lat === 'number' && typeof manual.lon === 'number') {
    return { lat: manual.lat, lon: manual.lon, source: 'manual', label: '手動指定' };
  }
  if (typeof exif.lat === 'number' && typeof exif.lon === 'number') {
    return { lat: exif.lat, lon: exif.lon, source: 'exif', label: '写真メタデータ (EXIF)' };
  }
  const near = findNearestGpsLocation(db, eatenAt, { windowMs: 5 * 60 * 1000 }) as { lat?: number; lon?: number; recorded_at?: string } | null;
  if (near && typeof near.lat === 'number' && typeof near.lon === 'number') {
    return {
      lat: near.lat,
      lon: near.lon,
      source: 'gps_track',
      label: `GPS 軌跡 ±5分 (${formatHm(near.recorded_at || '')})`,
    };
  }
  return { lat: null, lon: null, source: 'none', label: null };
}

function formatHm(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ─── Vision 解析 (LLM dispatch 経由) ───────────────────────────

const VISION_PROMPT_TEMPLATE = (absPath: string): string => [
  '次の食事写真を見て、 食事内容を JSON 1 オブジェクトで返してください。',
  '前後の説明文 / コードフェンス / コメントは禁止です。',
  '',
  `写真: @${absPath}`,
  '',
  'スキーマ:',
  '{',
  '  "description": "ひと言での食事内容 (例: \'カレーライスとサラダ\')",',
  '  "calories": <推定総カロリー (数値, kcal)>,',
  '  "items": [',
  '    {"name": "個別の料理名", "calories": <推定 kcal>}',
  '  ],',
  '  "nutrients": {',
  '    "protein_g":  <タンパク質 (g)>,',
  '    "fat_g":      <脂質 (g)>,',
  '    "carbs_g":    <炭水化物 (g)>,',
  '    "fiber_g":    <食物繊維 (g)>,',
  '    "sugar_g":    <糖質 (g)>,',
  '    "sodium_mg":  <塩分 (mg、 食塩相当量で構わない)>',
  '  }',
  '}',
  '',
  '不明な値: description は推測 (例 "料理 (推定不可)")、 数値は null。',
  '食事以外の写真: description="食事ではない", calories=null, items=[], nutrients は全 null。',
].join('\n');

/**
 * 食事写真を解析する。 photoAbsPath は OS 絶対パス。
 */
export async function analyzeMealPhoto(photoAbsPath: string): Promise<VisionResult> {
  const prompt = VISION_PROMPT_TEMPLATE(photoAbsPath);
  const stdout = await runLlm({
    task: 'meal_vision',
    prompt,
    tools: ['Read'],
    timeoutMs: 90_000,
  });
  return parseVisionJson(stdout);
}

// ─── 食品名 → 標準カロリー推定 (LLM 経由) ─────────────────────

const CALORIE_PROMPT = (foodName: string): string => [
  `食品名: ${foodName}`,
  '',
  '上記の食品の標準的な 1 食分 / 1 個分のカロリーと主要栄養素を推定してください。',
  '一般的なレシピサイト・栄養データベースの値を参考にした概数で構いません。',
  '',
  '返答は **次の JSON 1 オブジェクトだけ** にしてください (前後の説明 / コードフェンス禁止):',
  '{',
  '  "calories": <推定 kcal (数値) または null>,',
  '  "serving": "想定する分量 (例: \\"1 杯 (200g)\\", \\"1 個\\", \\"1 食分\\")",',
  '  "confidence": "high | medium | low",',
  '  "nutrients": {',
  '    "protein_g":  <タンパク質 (g) または null>,',
  '    "fat_g":      <脂質 (g) または null>,',
  '    "carbs_g":    <炭水化物 (g) または null>,',
  '    "fiber_g":    <食物繊維 (g) または null>,',
  '    "sugar_g":    <糖質 (g) または null>,',
  '    "sodium_mg":  <塩分 (mg) または null>',
  '  }',
  '}',
  '',
  '一般的な食品でない / 推定不能なら calories を null、 confidence を low、 nutrients は全 null。',
].join('\n');

export async function estimateCaloriesFromName(foodName: string): Promise<CalorieResult> {
  const cleaned = String(foodName ?? '').trim();
  if (!cleaned) return { calories: null, serving: '', confidence: 'low' };
  const stdout = await runLlm({
    task: 'meal_calorie',
    prompt: CALORIE_PROMPT(cleaned),
    timeoutMs: 60_000,
  });
  return parseCalorieJson(stdout);
}

interface RawCalorieObject {
  calories?: unknown;
  serving?: unknown;
  confidence?: unknown;
  nutrients?: unknown;
}

function parseCalorieJson(raw: string): CalorieResult {
  let s = (raw || '').trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  let obj: RawCalorieObject;
  try {
    obj = JSON.parse(s);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`calorie output is not JSON: ${msg}\nRaw (first 200): ${(raw || '').slice(0, 200)}`);
  }
  const calories = (typeof obj.calories === 'number' && isFinite(obj.calories)) ? Math.round(obj.calories) : null;
  const serving = typeof obj.serving === 'string' ? obj.serving.slice(0, 120) : '';
  const confidence: 'high' | 'medium' | 'low' = (obj.confidence === 'high' || obj.confidence === 'medium' || obj.confidence === 'low')
    ? obj.confidence : 'low';
  const nutrients = sanitizeNutrients(obj.nutrients);
  return { calories, serving, confidence, nutrients };
}

interface RawNutrientsObject {
  protein_g?: unknown;
  fat_g?: unknown;
  carbs_g?: unknown;
  fiber_g?: unknown;
  sugar_g?: unknown;
  sodium_mg?: unknown;
}

function sanitizeNutrients(input: unknown): MealNutrients | null {
  if (!input || typeof input !== 'object') return null;
  const keys: (keyof MealNutrients)[] = ['protein_g', 'fat_g', 'carbs_g', 'fiber_g', 'sugar_g', 'sodium_mg'];
  const obj = input as RawNutrientsObject;
  const out: MealNutrients = {
    protein_g: null, fat_g: null, carbs_g: null, fiber_g: null, sugar_g: null, sodium_mg: null,
  };
  let any = false;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && isFinite(v) && v >= 0) {
      out[k] = Math.round(v * 10) / 10;
      any = true;
    }
  }
  return any ? out : null;
}

interface RawVisionObject {
  description?: unknown;
  calories?: unknown;
  items?: unknown;
  nutrients?: unknown;
}

function parseVisionJson(raw: string): VisionResult {
  let s = (raw || '').trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);

  let obj: RawVisionObject;
  try {
    obj = JSON.parse(s);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`vision output is not JSON: ${msg}\nRaw (first 300): ${(raw || '').slice(0, 300)}`);
  }
  const description = typeof obj.description === 'string' ? obj.description : '';
  const calories = typeof obj.calories === 'number' && isFinite(obj.calories) ? Math.round(obj.calories) : null;
  let items: VisionResult['items'] = [];
  if (Array.isArray(obj.items)) {
    items = (obj.items as { name?: unknown; calories?: unknown }[])
      .filter((it) => it && typeof it === 'object' && typeof it.name === 'string')
      .map((it) => ({
        name: it.name as string,
        calories: typeof it.calories === 'number' && isFinite(it.calories) ? Math.round(it.calories) : null,
      }));
  }
  const nutrients = sanitizeNutrients(obj.nutrients);
  return { description, calories, items, nutrients };
}
