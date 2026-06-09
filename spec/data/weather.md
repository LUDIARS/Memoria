# data: 天気 (weather_snapshots / weather_ensemble_snapshots)

## weather_snapshots
単一ソース (Open-Meteo) の生 forecast を 1 fetch = 1 行。 既存 (`lib/weather.ts`)。
current/hourly/daily の JSON を date 別に保持。 日記表示・天気カードで使う。

## weather_ensemble_snapshots
**全API を突き合わせたアンサンブル**の保存 (`server/weather/ensemble-store.ts`)。

| column | type | 説明 |
|--------|------|------|
| id | INTEGER PK | |
| fetched_at | INTEGER | unix ms |
| date | TEXT | 取得時の today (YYYY-MM-DD, local) |
| lat / lon | REAL | 地点 |
| label | TEXT | 地点名 (自宅/会社等)。 null 可 |
| agreement_threshold | REAL | 雨と見なす一致率 (保存時の設定) |
| sources_json | TEXT | `[{id, ok, error, points}]` — どのソースが成功したか |
| hours_json | TEXT | `EnsembleHour[]` — 時刻別 votesRain/votesTotal/agreement/avgPop/maxPrecipMm |

INDEX: `(fetched_at DESC)`。

書き込み: `/api/weather/ensemble` (UI の「取得」)、 朝のブリーフィング (対象地点ごと)。
読み出し: `/api/weather/ensemble/snapshots` (一覧)、 `/snapshot/:id` (単件)。
spec/feature/weather-multisource.md。
