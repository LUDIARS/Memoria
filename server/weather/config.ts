// app_settings から天気マルチソース設定を読む。 ソースの有効/無効・API キー・
// 朝ブリーフィング・一致率しきい値を 1 箇所に集約する。

import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings } from '../db.js';
import type { SourceContext } from './sources/types.js';
import { DEFAULT_ENABLED_IDS, ALL_SOURCES } from './sources/index.js';

type Db = BetterSqlite3.Database;

export interface WeatherConfig {
  enabledSourceIds: string[];
  ctx: SourceContext;
  agreementThreshold: number;          // 雨と見なす最低一致率 (0..1)
  briefing: {
    enabled: boolean;
    hour: number;                      // 0-23
    notifyWhenClear: boolean;
  };
}

function num(v: string | null | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function getWeatherConfig(db: Db): WeatherConfig {
  const s = getAppSettings(db);

  const rawEnabled = (s['weather.sources.enabled'] ?? '').trim();
  const validIds = new Set(ALL_SOURCES.map((x) => x.id));
  const enabledSourceIds = rawEnabled
    ? rawEnabled.split(',').map((x) => x.trim()).filter((x) => validIds.has(x))
    : [...DEFAULT_ENABLED_IDS];

  const contact = (s['weather.contact_email'] ?? 'kazmit299@gmail.com').trim();

  return {
    enabledSourceIds: enabledSourceIds.length ? enabledSourceIds : [...DEFAULT_ENABLED_IDS],
    ctx: {
      openweathermapApiKey: (s['weather.sources.openweathermap.api_key'] ?? '').trim() || undefined,
      weatherapiApiKey: (s['weather.sources.weatherapi.api_key'] ?? '').trim() || undefined,
      userAgent: `Memoria/1.0 (+https://github.com/LUDIARS; ${contact})`,
    },
    agreementThreshold: Math.min(1, Math.max(0, num(s['weather.agreement_threshold'], 0.5))),
    briefing: {
      enabled: (s['weather.morning_briefing.enabled'] ?? 'true') !== 'false',
      hour: Math.min(23, Math.max(0, Math.round(num(s['weather.morning_briefing.hour'], 7)))),
      notifyWhenClear: (s['weather.morning_briefing.notify_when_clear'] ?? 'false') === 'true',
    },
  };
}
