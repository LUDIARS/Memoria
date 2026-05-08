# note — ノート (markdown ライク WYSIWYG ドキュメント)

esa / DocBase 風の WYSIWYG ノート。 1 ノート = ヘッダ (`notes`) + N 個のブロック (`note_blocks`) で表現する Notion 型のブロックベース構造。

## `notes`
ノートのヘッダ + メタ。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `title` | TEXT | ✓ | `''` | タイトル (空文字許容) |
| `kind` | TEXT | ✓ | `'doc'` | 将来分岐用。 `doc` (汎用) / `chat` (拡張からの取り込み) / `meeting` 等 |
| `tags_json` | TEXT |  | NULL | JSON `string[]` (タグ) |
| `source_kind` | TEXT |  | NULL | 取り込み元種別。 `chat` (extension chat 取り込み) 等 |
| `source_ref` | TEXT |  | NULL | 取り込み元参照 (URL や conversation_id 等) |
| `created_at` | TEXT | ✓ | UTC | |
| `updated_at` | TEXT | ✓ | UTC | ヘッダか任意のブロック更新時に bump |
| `owner_user_id` | TEXT |  | NULL | Hub 連携 (将来) |
| `owner_user_name` | TEXT |  | NULL | |
| `shared_at` | TEXT |  | NULL | |
| `shared_origin` | TEXT |  | NULL | |

Index: `idx_notes_updated` (updated_at DESC) / `idx_notes_kind` / `idx_notes_source` (source_kind, source_ref)

## `note_blocks`
ノートを構成するブロック (1 行 = 1 ブロック)。 表示順は `position` で安定ソート。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `note_id` | INTEGER | ✓ | — | FK → `notes(id)`, ON DELETE CASCADE |
| `position` | REAL | ✓ | — | 並び順。 REAL で挿入時に隣接 2 ブロックの平均値を取れば挿入で全体 reindex 不要 |
| `block_type` | TEXT | ✓ | `'text'` | 後述 |
| `text` | TEXT | ✓ | `''` | 本文 (markdown インライン込み)。 table / mermaid 系では未使用 (空文字) |
| `data_json` | TEXT |  | NULL | type 固有データ (JSON)。 後述 |
| `created_at` | TEXT | ✓ | UTC | |
| `updated_at` | TEXT | ✓ | UTC | |

Index: `idx_note_blocks_note_position` (note_id, position) / `idx_note_blocks_updated` (updated_at)

### `block_type` enum
- `text` — 段落 (markdown インライン: `**bold**`, `*italic*`, `` `code` ``, `[link](url)`, `<span style="color:#hex">…</span>`)
- `heading_1` / `heading_2` / `heading_3` — 見出し
- `quote` — 引用
- `code` — コードブロック (`data_json.lang: string`)
- `mermaid` — Mermaid 図 (`text` に Mermaid ソース)
- `table` — テーブル (`data_json.rows: string[][]`、 `data_json.header: boolean` で 1 行目をヘッダ扱い)
- `bullet_list` / `numbered_list` — リスト (`data_json.indent: number` 0 起点)
- `todo` — チェックボックス (`data_json.checked: boolean`)
- `divider` — 水平線 (`text` 未使用)

### `data_json` schema (type 別)
```ts
// code
{ lang?: string }
// table
{ header?: boolean; rows: string[][] }
// bullet_list / numbered_list
{ indent?: number }
// todo
{ checked: boolean }
// その他: null OR {}
```

## 関連
- `note_blocks` の text に埋め込む `<span style="color:#…">` は signaling 上 markdown extension。 描画時は HTML として直接挿入せず、 サーバ側 / フロント側のサニタイザで `style` 内の `color: #[0-9a-f]{3,8}` のみ allowlist する。
- `position` が同値で衝突した場合は `id` の昇順で stable。 編集 UI 側は挿入時に必ずユニークな値を計算する責務を持つ。

## マイグレーション
新規テーブル追加のみ。 既存データへの影響なし。
