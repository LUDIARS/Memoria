# impl — 実装自慢

## `implementation_notes`
| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `product` | TEXT | ✓ | — | 対象プロダクト名 |
| `title` | TEXT | ✓ | — | ドヤポイント |
| `good_points` `bad_points` | TEXT |  | NULL | |
| `attachment_type` | TEXT |  | NULL | `''` / `github` / `article` / `screenshot` / `video` / `code` / `other` |
| `attachment_value` | TEXT |  | NULL | URL / data:URL / コード片 / ファイル名など |
| `shareable` | INTEGER | ✓ | 0 | 1=Hub にシェア可 |
| `shared_at` `shared_origin` | TEXT |  | NULL | |
| `created_at` `updated_at` | TEXT | ✓ | UTC | |

Index: `idx_implementation_notes_created`

## attachment_type 自動分類 (UI 側)
編集モーダルで paste / drop すると以下のように自動分類:
- 画像 → `screenshot`
- video file → `video`
- URL: github.com → `github` / その他 → `article`
- 多行コード → `code`
- その他ファイル → `other`
