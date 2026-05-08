# wordcloud — ワードクラウド (○ 抽象用語 / □ 具体名詞)

## `word_clouds`
Bookmark / Dig / 過去 Cloud から派生したクラウド。 `parent_cloud_id`
+ `parent_word` でドリルダウンチェーンを表現。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `origin` | TEXT | ✓ | — | `bookmark` / `bookmarks` / `dig` / `merged` |
| `origin_dig_id` | INTEGER |  | NULL | dig_sessions(id) (origin=dig 時) |
| `origin_bookmark_id` | INTEGER |  | NULL | bookmarks(id) (origin=bookmark 時、 CASCADE) |
| `parent_cloud_id` | INTEGER |  | NULL | 派生元 cloud (drill-down チェーン) |
| `parent_word` | TEXT |  | NULL | 親クラウドのどの語から drill したか |
| `label` | TEXT | ✓ | — | クラウド名 |
| `status` | TEXT | ✓ | `pending` | `pending` / `done` / `error` |
| `error` | TEXT |  | NULL | |
| `result_json` | TEXT |  | NULL | ノード + エッジ (JSON) |
| `created_at` | TEXT | ✓ | UTC | |

Index: `idx_word_clouds_created` / `idx_word_clouds_bookmark`
