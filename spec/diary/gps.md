# `diary/gps.js` — GPS 集計 + Haversine

## 目的

GPS 軌跡 (`gps_locations` テーブル) を 1 日分集計し、 距離 / bbox /
時間帯を日記プロンプトに渡せる形にする。

## 公開関数

```js
parseSqliteUtc(s: string | null): Date | null
haversineMeters(a: { lat, lon }, b: { lat, lon }): number
summarizeGpsForDate(points: Array): {
  points, devices, distance_meters, bbox, midpoint, hours, first_at, last_at
}
```

### `parseSqliteUtc(s)`
- SQLite `datetime()` の出力 (`"YYYY-MM-DD HH:MM:SS"`) を **UTC** として解釈
- 既に TZ サフィックス (Z / +09:00) があるならそのまま `new Date()` に渡す
- 空 / null は `null`

**Why**: SQLite 文字列をそのまま `new Date()` に渡すとローカル TZ として
解釈される (バグ)。 必ず `Z` を追加して UTC として読む。

### `haversineMeters(a, b)`
- 球面三角公式で大圏距離 (m) を計算。 地球半径 6,371,008 m。
- 短距離は数 cm 精度。 1° 緯度 ≒ 111 km。

### `summarizeGpsForDate(points)`
- 入力: GPS 点列 (時刻順、 各点 `{ recorded_at, lat, lon, device_id?, accuracy_m? }`)
- 出力:
  - `points`: 入力点数
  - `devices`: 関与した device_id (重複なし)
  - `distance_meters`: 連続 2 点の Haversine 和 (jitter 込み = やや過大)
  - `bbox`: `{ lat: [min, max], lon: [min, max] }` (5 桁丸め)
  - `midpoint`: bbox の中心
  - `hours`: 観測した hour (0-23) の重複なしソート列
  - `first_at` / `last_at`: 端点

**精度フィルタ**: `accuracy_m > 200` の点は連続性を信頼せず、 距離計算
からスキップ (jitter で距離が爆発するのを防ぐ)。

## 不変条件

- 純関数。 DB アクセス無し (DB は呼出側で取得)。
- 空入力でも safe (zero metrics object を返す)。

## テスト

`server/test/diary-gps.test.js` (8 tests)

- Tokyo→Osaka ≒ 392 km (実測 392.4 km)
- 1° 緯度 ≒ 111 km
- 同一点で 0 m
- SQLite UTC 文字列の TZ 補正
- 空入力 / 通常入力の集計

## 既知の制限

- 静止判定 (例: 同点 30 分滞留 = 「滞在」) は誤判定リスクが高いので未実装
- jitter 補正は未実装 (距離が概算)
- Haversine は球面前提 (WGS84 楕円体は使わない)
