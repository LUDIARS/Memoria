# dictionary — 辞書 + 出典リンク

## `dictionary_entries`
ユーザ作成 / Hub からダウンロードした辞書エントリ。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `term` | TEXT | ✓ | — | UNIQUE。 Hub からの取り込みは `(@user)` で suffix 化される |
| `definition` | TEXT |  | NULL | 定義 |
| `notes` | TEXT |  | NULL | 補足 |
| `created_at` | TEXT | ✓ | UTC | |
| `updated_at` | TEXT | ✓ | UTC | |
| `owner_user_id` | TEXT |  | NULL | Hub 連携 |
| `owner_user_name` | TEXT |  | NULL | |
| `shared_at` | TEXT |  | NULL | |
| `shared_origin` | TEXT |  | NULL | |

## `dictionary_links`
辞書エントリの出典 (どの bookmark / dig / cloud から来たか)。

| 列 | 型 | NotNull | 役割 |
|---|---|---|---|
| `entry_id` | INTEGER | ✓ | FK → dictionary_entries(id), CASCADE |
| `source_kind` | TEXT | ✓ | `cloud` / `dig` / `bookmark` |
| `source_id` | INTEGER | ✓ | 各 origin の row id |
| `added_at` | TEXT | ✓ | UTC ISO |

PK: `(entry_id, source_kind, source_id)`
Index: `idx_dict_links_entry` / `idx_dict_links_source`
