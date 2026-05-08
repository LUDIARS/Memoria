# dig — Deep research セッション + recommendation 棄却

## `dig_sessions`
Phase 0 (raw SERP) → Phase 1 (preview) → Phase 2 (deep) の 3 段階で生成される
deep research 結果。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `query` | TEXT | ✓ | — | ユーザのクエリ |
| `created_at` | TEXT | ✓ | UTC | |
| `status` | TEXT | ✓ | `pending` | `pending` / `done` / `error` |
| `error` | TEXT |  | NULL | |
| `result_json` | TEXT |  | NULL | Phase 2 deep 結果 (JSON) |
| `preview_json` | TEXT |  | NULL | Phase 1 preview |
| `raw_results_json` | TEXT |  | NULL | Phase 0 raw SERP (DuckDuckGo / Bing / etc.) |
| `theme` | TEXT |  | NULL | 任意の caller-supplied テーマ |
| `owner_user_id` `owner_user_name` `shared_at` `shared_origin` | TEXT |  | NULL | Hub 連携 |

Index: `idx_dig_sessions_created` (`created_at DESC`)

## `recommendation_dismissals`
おすすめタブで「不要」マークした URL のブラックリスト。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `url` | TEXT | ✓ | — | PK |
| `dismissed_at` | TEXT | ✓ | UTC | |
