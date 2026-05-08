# meal — 食事記録

## `meals`
写真 + EXIF + Vision + 手動補正 のミックス。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `photo_path` | TEXT | ✓ | — | `<DATA>/meals/<file>` 相対パス |
| `eaten_at` | TEXT | ✓ | — | UTC ISO |
| `eaten_at_source` | TEXT | ✓ | `manual` | `manual` / `exif` / `gps` / `inference` |
| `lat` `lon` | REAL |  | NULL | 撮影位置 |
| `location_label` `location_source` | TEXT |  | NULL | 推定された施設名 |
| `description` | TEXT |  | NULL | AI が生成した説明 |
| `calories` | INTEGER |  | NULL | AI 推定値 |
| `items_json` | TEXT |  | NULL | `[{name, calories, ...}]` |
| `nutrients_json` | TEXT |  | NULL | `{protein, fat, carbs, ...}` |
| `ai_status` | TEXT | ✓ | `pending` | `pending` / `running` / `done` / `error` |
| `ai_error` | TEXT |  | NULL | |
| `user_note` | TEXT |  | NULL | ユーザの自由記述 |
| `user_corrected_description` `user_corrected_calories` |  |  | NULL | AI 出力に対する手動補正 |
| `additions_json` | TEXT |  | NULL | おかわり等の追加分 (JSON) |
| `created_at` `updated_at` | TEXT | ✓ | UTC | |

Index: `idx_meals_eaten_at` / `idx_meals_ai_status`
