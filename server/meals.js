// 食事記録の補助モジュール
//
// - EXIF パース (時刻 / GPS) — exifr ライブラリ
// - GPS 軌跡からの後付け推定
// - OpenAI Vision (gpt-4o-mini) による食事内容 / カロリー推定
//
// 設計判断:
//   - Vision API は OpenAI のみ対応 (Claude / Gemini CLI への画像渡しは
//     一貫性が薄れるため、 別 PR で拡張予定)
//   - OPENAI_API_KEY が無い時は AI 解析を skip して `pending` のまま放置 →
//     ユーザが /api/meals/:id/reanalyze で後から実行できる
//   - 個人データ非保管ルール対象外 (Memoria は単一ユーザ前提のローカル DB)

import exifr from 'exifr';
import { findNearestGpsLocation, getAppSettings } from './db.js';

/** 画像バッファから EXIF を抽出する。 失敗しても throw せず空 meta を返す。 */
export async function extractPhotoMeta(buf) {
  try {
    const data = await exifr.parse(buf, {
      tiff: true,
      ifd0: true,
      exif: true,
      gps: true,
      pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'latitude', 'longitude'],
    });
    if (!data) return { capturedAt: null, lat: null, lon: null };
    let captured = null;
    for (const k of ['DateTimeOriginal', 'CreateDate', 'ModifyDate']) {
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
export function resolveMealLocation(db, exif, eatenAt, manual) {
  if (manual && typeof manual.lat === 'number' && typeof manual.lon === 'number') {
    return { lat: manual.lat, lon: manual.lon, source: 'manual', label: '手動指定' };
  }
  if (typeof exif.lat === 'number' && typeof exif.lon === 'number') {
    return { lat: exif.lat, lon: exif.lon, source: 'exif', label: '写真メタデータ (EXIF)' };
  }
  const near = findNearestGpsLocation(db, eatenAt, { windowMs: 5 * 60 * 1000 });
  if (near && typeof near.lat === 'number' && typeof near.lon === 'number') {
    return {
      lat: near.lat,
      lon: near.lon,
      source: 'gps_track',
      label: `GPS 軌跡 ±5分 (${formatHm(near.recorded_at)})`,
    };
  }
  return { lat: null, lon: null, source: 'none', label: null };
}

function formatHm(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ─── OpenAI Vision ────────────────────────────────────────────

const VISION_PROMPT = `あなたは食事記録アプリの AI アシスタントです。 画像を見て食事内容を JSON で返してください。

返答は **次の JSON だけ** にしてください (コードブロック不要):
{
  "description": "ひと言での食事内容 (例: 'カレーライスとサラダ')",
  "calories": <推定総カロリー (数値, kcal)>,
  "items": [
    {"name": "個別の料理名", "calories": <推定 kcal>}
  ]
}

不明な値は description は推測 (例: "料理 (推定不可)")、 数値は null にしてください。 食事以外の写真の場合は description に "食事ではない" と書き、 calories は null、 items は [] にしてください。`;

/** 画像 (base64) から食事内容 / カロリーを推定。 OPENAI_API_KEY が無い / API
 *  失敗時は throw or null。 caller 側で error を記録する。 */
export async function analyzeMealPhoto(apiKey, imageBase64, mimeType) {
  if (!apiKey) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60_000);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: VISION_PROMPT },
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${imageBase64}` },
              },
            ],
          },
        ],
        temperature: 0.2,
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 400);
      throw new Error(`OpenAI Vision ${res.status}: ${body}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim() ?? '';
    return parseVisionJson(text);
  } finally {
    clearTimeout(timer);
  }
}

function parseVisionJson(text) {
  // モデルがコードブロックで返してきた場合に取り除く
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const obj = JSON.parse(s);
  const description = typeof obj.description === 'string' ? obj.description : '';
  const calories = typeof obj.calories === 'number' && isFinite(obj.calories) ? Math.round(obj.calories) : null;
  let items = [];
  if (Array.isArray(obj.items)) {
    items = obj.items
      .filter((it) => it && typeof it === 'object' && typeof it.name === 'string')
      .map((it) => ({
        name: it.name,
        calories: typeof it.calories === 'number' && isFinite(it.calories) ? Math.round(it.calories) : null,
      }));
  }
  return { description, calories, items };
}

/** app_settings から OpenAI API key を取得。 llm.openai.api_key が優先、 env が fallback。 */
export function getMealsApiKey(db) {
  const settings = getAppSettings(db);
  const fromSettings = (settings['llm.openai.api_key'] || '').trim();
  if (fromSettings) return fromSettings;
  return (process.env.OPENAI_API_KEY || '').trim();
}
