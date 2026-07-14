# workplace — 作業場所

## `work_locations`
| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `name` | TEXT | ✓ | — | 例: "WeWork 六本木" / "自宅" |
| `address` | TEXT |  | NULL | |
| `latitude` `longitude` | REAL |  | NULL | GPS 座標 (workplace match に必須) |
| `description` | TEXT |  | NULL | |
| `url` | TEXT |  | NULL | 公式サイト |
| `tags` | TEXT |  | NULL | カンマ区切り (`wifi, 電源, 静か`) |
| `shareable` | INTEGER | ✓ | 0 | 1=Hub にシェア可 |
| `shared_at` `shared_origin` | TEXT |  | NULL | |
| `owner_user_id` `owner_user_name` | TEXT |  | NULL | Hub からダウンロード時にセット (NULL=自分) |
| `created_at` `updated_at` | TEXT | ✓ | UTC | |

Index: `idx_work_locations_created`

## 自宅判定
セッション検出側で `name` に `自宅` を含むか `/home/i` にマッチすると
`is_home=true` 扱い (activity_events を要件に追加)。
