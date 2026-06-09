# 天気: マルチソース・アンサンブル + 朝の雨ブリーフィング

`server/weather/` ドメイン。 旧来の単一ソース (Open-Meteo) 天気を、 **複数の独立した
予報モデルを突き合わせて検証する** 構成に拡張する。 「本当に雨が降るか」 を 1 サイトの
予報に頼らず、 複数ソースの一致度 (agreement) で判断する。

雨判定そのものと「その曜日に行きがちな場所」 の推定は、 [成長型ブラックボックス]
(blackbox.md) に委ねる。 最初は LLM、 徐々にルール (アルゴリズム) へ置き換わる。

## 1. ソース (天気サイト)

各ソースは `WeatherSource` interface を実装した独立アダプタ。 `fetch(lat, lon)` で
**正規化済みの hourly 予報** (`SourceForecast`) を返す。 ソースを足すときは
`sources/<name>.ts` を 1 本足して `sources/index.ts` の registry に登録するだけ。

| id | 由来モデル | キー | 備考 |
|----|-----------|------|------|
| `open-meteo-ecmwf` | ECMWF IFS | 不要 | Open-Meteo `models=ecmwf_ifs04` |
| `open-meteo-gfs`   | NOAA GFS  | 不要 | Open-Meteo `models=gfs_seamless` |
| `open-meteo-icon`  | DWD ICON  | 不要 | Open-Meteo `models=icon_seamless` |
| `open-meteo-jma`   | 気象庁 MSM/GSM | 不要 | Open-Meteo `models=jma_seamless` (国内精度) |
| `metno`            | MET Norway | 不要 (User-Agent 必須) | locationforecast 2.0 |
| `openweathermap`   | OWM ブレンド | **要** (無料枠) | `weather.sources.openweathermap.api_key` |
| `weatherapi`       | WeatherAPI.com ブレンド | **要** (無料枠) | `weather.sources.weatherapi.api_key` |

- キー必須ソースはキー未設定なら自動 skip (= ソース数が減るだけで動く)。
- Open-Meteo 由来は同一プロバイダだが **モデルが独立** なので予報は独立。 met.no /
  OWM / WeatherAPI は完全独立。 → 実質 5〜7 の独立予報を確保。
- 各ソースは `SourceForecast { sourceId, ok, error?, points: HourPoint[] }` を返す。
  `HourPoint = { timeLocalIso, willRain, pop|null, precipMm|null, code?, label? }`。

## 2. アンサンブル (`ensemble.ts`)

同一 (lat, lon) に対する N ソースの `SourceForecast` を時刻ごとに突き合わせる。

- 時刻バケットは local の "YYYY-MM-DDTHH" (1 時間刻み) に正規化。
- 各バケットで `rainVotes / availableVotes` (= agreement)、 `avgPop`、 `maxPrecipMm`、
  どのソースが雨と言ったか (`agreeSources` / `disagreeSources`) を集計。
- `EnsembleHour { hour, votesRain, votesTotal, agreement, avgPop, maxPrecipMm }`。
- これを `weather.will_rain` ブラックボックスの **特徴量 (features)** に変換する
  (`domains.ts`)。 雨の有無の最終判定は blackbox が下す。

## 3. 対象地点 (`targets.ts`)

通知・検証の対象となる地点を決める。

- **自宅 (必須)**: `work_locations WHERE is_home=1`。 lat/lon を持つもの。
- **その曜日に行きがちな場所**: `gps_locations` の履歴を曜日で絞り、 place_name /
  最寄り `work_locations` 単位に集計して上位を採る。 この「行く可能性が高いか」 の
  判断は `weather.likely_place` ブラックボックスに委ねる (最初は LLM)。
- 結果は `TargetPlace { name, lat, lon, kind: 'home'|'likely', source: 'rule'|'llm', rationale }`。

## 4. 朝の雨ブリーフィング (`briefing.ts` + scheduler)

毎朝 `weather.morning_briefing.hour` (既定 7 時) に 1 回:

1. 今日の対象地点 (自宅 + 行きがちな場所) を決める。
2. 各地点で全ソースを fetch → アンサンブル → `weather.will_rain` で判定。
3. 雨が降る地点があれば push 通知:
   - `☔ 今日 [自宅] 14時頃から雨 (6/7ソース一致 / 降水確率 70%)`
   - 複数地点はまとめて 1 通。 雨ゼロなら送らない (設定で「晴れも知らせる」 可)。
4. 判定根拠を必ず併記: **何ソース中何ソースが雨か** / **ルール由来か LLM 由来か** /
   ルールが未承認 (pending) なら「ルールで判定 — OK/NG を待っています」 を添える。

既存の 30 分おき「いま雨」 アラート (`startWeatherRainAlertInterval`) は単一ソースの
ままライト通知として残す。 朝ブリーフィングがマルチソース版の主役。

## 5. 設定キー (app_settings)

| key | 既定 | 説明 |
|-----|------|------|
| `weather.sources.enabled` | 全キーレス | 有効ソース id の CSV。 空なら既定セット |
| `weather.sources.openweathermap.api_key` | (空) | OWM 無料キー |
| `weather.sources.weatherapi.api_key` | (空) | WeatherAPI.com 無料キー |
| `weather.morning_briefing.enabled` | true | 朝ブリーフィング on/off |
| `weather.morning_briefing.hour` | 7 | 送信時刻 (0-23) |
| `weather.morning_briefing.notify_when_clear` | false | 晴れでも送るか |
| `weather.agreement_threshold` | 0.5 | 雨と見なす最低一致率 (blackbox 既定ルールが参照) |
| `weather.morning_briefing.last_sent_date` | — | 当日重複送信ガード |

API キーは平文保存になるため [設定はファイル管理・シークレットは非平文]
([[feedback_config_and_secrets]]) の例外として、 ローカル SQLite 限定・個人 PC 常駐
前提で許容する (Memoria の既存 `maps.api_key` と同方針)。 将来 Infisical 移行対象。

## 6. API

| method | path | 説明 |
|--------|------|------|
| GET | `/api/weather/ensemble?lat=&lon=` | 1 地点のマルチソース・アンサンブル |
| GET | `/api/weather/targets` | 今日の対象地点 (自宅 + 行きがち) |
| GET | `/api/weather/briefing` | 今日の雨ブリーフィングを即時生成 (送信せず返す) |
| GET/PATCH | `/api/weather/sources` | ソース有効/無効 + キー設定 |

## 関連

- [成長型ブラックボックス](blackbox.md) — 雨判定 / 行きがち場所の判断エンジン
- 既存 `lib/weather.ts` (Open-Meteo プリミティブ + WMO code + snapshot) を流用
- `work_locations` ([[project workplace]] spec/data/workplace.md) / `gps_locations`
