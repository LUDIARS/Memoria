// 天気ソース (サイト) の共通インタフェース。
//
// 各ソースは fetch(lat, lon) で「正規化済みの hourly 予報」 を返す。 ソースごとの
// 生フォーマットの違い (WMO code / met.no symbol / OWM id / WeatherAPI code) は
// アダプタ内で吸収し、 外には willRain / pop / precipMm だけを出す。

/** 1 時間ぶんの正規化された予報点。 */
export interface HourPoint {
  /** local TZ の ISO ("2026-06-09T14:00")。 時刻バケットのキーに使う。 */
  timeLocalIso: string;
  /** このソースがこの時刻に「雨」 と言っているか。 */
  willRain: boolean;
  /** 降水確率 % (0-100)。 ソースが持たなければ null。 */
  pop: number | null;
  /** 降水量 mm。 持たなければ null。 */
  precipMm: number | null;
  /** ソース固有の天気ラベル (任意、 表示用)。 */
  label?: string;
}

/** 1 ソースの 1 地点ぶんの取得結果。 */
export interface SourceForecast {
  sourceId: string;
  ok: boolean;
  error?: string;
  points: HourPoint[];
}

/** API キーなどソースが必要とする実行コンテキスト。 */
export interface SourceContext {
  openweathermapApiKey?: string;
  weatherapiApiKey?: string;
  /** met.no が要求する User-Agent。 連絡先付き。 */
  userAgent: string;
}

/** 天気ソースアダプタ。 */
export interface WeatherSource {
  /** registry / 設定で使う安定 id。 */
  id: string;
  /** 表示名。 */
  label: string;
  /** キー必須ソースで未設定なら false → registry が skip。 */
  isAvailable(ctx: SourceContext): boolean;
  fetch(lat: number, lon: number, ctx: SourceContext): Promise<HourPoint[]>;
}

export const SOURCE_FETCH_TIMEOUT_MS = 15_000;
