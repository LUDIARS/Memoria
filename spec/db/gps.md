# gps — GPS 軌跡

## `gps_locations`
OwnTracks / Legatus 経由の GPS 1 点 = 1 行。 停止区間は始点 + 終点の 2 行に
圧縮される (samples_count で代表数を保持)。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `user_id` | TEXT | ✓ | `'me'` | 単独運用なら 'me' |
| `device_id` | TEXT |  | NULL | "iphone" / "android" 等 |
| `recorded_at` | TEXT | ✓ | — | UTC ISO (発信時刻) |
| `lat` `lon` | REAL | ✓ | — | 緯度・経度 |
| `accuracy_m` `altitude_m` `velocity_kmh` `course_deg` `battery_pct` | REAL/INT |  | NULL | 各種メタ |
| `conn` | TEXT |  | NULL | "wifi" / "cellular" 等 |
| `raw_json` | TEXT |  | NULL | OwnTracks 元 payload |
| `received_at` | TEXT | ✓ | UTC | サーバ受信時刻 |
| `samples_count` | INTEGER | ✓ | 1 | 圧縮終点行が代表する raw 数 (≥2 で圧縮済) |
| `samples_first_at` | TEXT |  | NULL | 圧縮窓開始時刻 (UTC ISO) |
| `place_name` | TEXT |  | NULL | 逆ジオコーディング結果 |
| `place_address` | TEXT |  | NULL | |
| `place_source` | TEXT |  | NULL | `places` / `geocode` / `cached` / `failed` |
| `place_resolved_at` | INTEGER |  | NULL | unix ms。 NULL = 未解決 |

Index: `idx_gps_locations_at` / `idx_gps_locations_user_at` / `idx_gps_locations_dedup` / `idx_gps_locations_unresolved`
