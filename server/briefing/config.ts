// app_settings から briefing.* 設定を読む。 天気と同じく 1 箇所に集約する。
// すべて opt-out / 既定値あり。 値は文字列で保存され、 ここで型へ正規化する。

import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings } from '../db.js';
import { settingBool } from '../lib/privacy.js';

type Db = BetterSqlite3.Database;

export interface BriefingConfig {
  enabled: boolean;
  /** 投稿間隔 (分)。 最小 5。 既定 30。 */
  intervalMinutes: number;
  /** 稼働時間帯 [start, end)。 この時間内だけ投稿する。 */
  activeStartHour: number;
  activeEndHour: number;
  /** Discord #briefing に投稿するか。 */
  toDiscord: boolean;
  /** Hora (デスクトップおじさん) に投稿するか。 */
  hora: { enabled: boolean; url: string };
  /** 各セクションの有効/無効。 */
  sections: {
    train: boolean;
    weather: boolean;
    news: boolean;
    tasks: boolean;
    environment: boolean;
    disaster: boolean;
  };
  /** 運行情報の対象路線 (路線名の部分一致)。 空なら「未設定」 表示。 */
  trainLines: string[];
  /** 「直近 N 分のニュース」 の N。 既定は intervalMinutes。 */
  newsWindowMinutes: number;
  /** 防災: 気象警報・注意報の対象エリアコード (気象庁、 例 '130000'=東京)。 空なら警報セクションを省く。 */
  jmaAreaCode: string;
  /** 防災: 地震を載せる最小震度スケール (P2P maxScale、 30=震度3)。 */
  earthquakeMinScale: number;
  /** 位置 (固定 lat/lon 優先、 無ければ呼び出し側が GPS で補完)。 */
  fixedLocation: { lat: number; lon: number } | null;
}

function num(v: string | null | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function getBriefingConfig(db: Db): BriefingConfig {
  const s = getAppSettings(db);

  const interval = Math.max(5, Math.round(num(s['briefing.interval_minutes'], 30)));
  const rawLines = (s['briefing.train.lines'] ?? '').trim();
  const trainLines = rawLines ? rawLines.split(',').map((x) => x.trim()).filter(Boolean) : [];

  const fLat = num(s['weather.fixed_lat'], NaN);
  const fLon = num(s['weather.fixed_lon'], NaN);
  const fixedLocation = Number.isFinite(fLat) && Number.isFinite(fLon) && (fLat !== 0 || fLon !== 0)
    ? { lat: fLat, lon: fLon }
    : null;

  return {
    enabled: settingBool(s, 'briefing.enabled', true),
    intervalMinutes: interval,
    activeStartHour: Math.min(23, Math.max(0, Math.round(num(s['briefing.active_start_hour'], 6)))),
    activeEndHour: Math.min(24, Math.max(1, Math.round(num(s['briefing.active_end_hour'], 23)))),
    toDiscord: settingBool(s, 'briefing.discord', true),
    hora: {
      enabled: settingBool(s, 'briefing.hora.enabled', false),
      url: (s['briefing.hora.url'] ?? 'http://127.0.0.1:5179/api/say').trim(),
    },
    sections: {
      train: settingBool(s, 'briefing.section.train', true),
      weather: settingBool(s, 'briefing.section.weather', true),
      news: settingBool(s, 'briefing.section.news', true),
      tasks: settingBool(s, 'briefing.section.tasks', true),
      environment: settingBool(s, 'briefing.section.environment', true),
      disaster: settingBool(s, 'briefing.section.disaster', true),
    },
    trainLines,
    newsWindowMinutes: Math.max(5, Math.round(num(s['briefing.news_window_minutes'], interval))),
    jmaAreaCode: (s['briefing.disaster.jma_area_code'] ?? '').trim(),
    earthquakeMinScale: Math.round(num(s['briefing.disaster.eq_min_scale'], 30)),
    fixedLocation,
  };
}
