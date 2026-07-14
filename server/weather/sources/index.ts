// 天気ソース registry + 並列取得。 ソースを足すときはここに 1 行 import + 登録。

import type { SourceContext, SourceForecast, WeatherSource } from './types.js';
import { openMeteoSources } from './open-meteo.js';
import { metnoSource } from './metno.js';
import { openweathermapSource } from './openweathermap.js';
import { weatherapiSource } from './weatherapi.js';

export * from './types.js';

/** 全登録ソース (キー必須も含む)。 */
export const ALL_SOURCES: WeatherSource[] = [
  ...openMeteoSources,
  metnoSource,
  openweathermapSource,
  weatherapiSource,
];

/** キー不要で常に使える既定セット (enabled 設定が空のときのフォールバック)。 */
export const DEFAULT_ENABLED_IDS = [
  ...openMeteoSources.map((s) => s.id),
  metnoSource.id,
];

export function findSource(id: string): WeatherSource | undefined {
  return ALL_SOURCES.find((s) => s.id === id);
}

/**
 * 有効かつ利用可能 (キーが揃っている) ソースを並列取得する。
 * 1 ソースの失敗は ok:false で握り潰し、 他ソースを止めない。
 */
export async function runEnabledSources(
  lat: number, lon: number, ctx: SourceContext, enabledIds: string[],
): Promise<SourceForecast[]> {
  const targets = enabledIds
    .map(findSource)
    .filter((s): s is WeatherSource => !!s && s.isAvailable(ctx));

  const results = await Promise.allSettled(
    targets.map(async (s) => ({ sourceId: s.id, points: await s.fetch(lat, lon, ctx) })),
  );

  return results.map((r, i): SourceForecast => {
    const id = targets[i].id;
    if (r.status === 'fulfilled') return { sourceId: id, ok: true, points: r.value.points };
    const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return { sourceId: id, ok: false, error: err, points: [] };
  });
}
