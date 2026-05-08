# note — ノート (markdown ライク WYSIWYG ドキュメント)

esa / DocBase 風の WYSIWYG ノート。 Notion 同様 1 ノート = ヘッダ (`notes`) + N 個のブロック (`note_blocks`) で表現するブロックベース構造。

ノート ID は **UUID** で管理し、 マルチサーバ間で同じ note を一意に識別できるようにする。 ノートに対する各個人のコメントは `note_comment_sets` (per note × user) + `note_comments` (1 行 1 コメント) の 2 段構成で別 UUID 名前空間を持つ。

## `notes`
ノートのヘッダ + メタ。 PK は **UUID** (string)。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | TEXT | ✓ | — | **UUID** (`crypto.randomUUID()`)。 マルチサーバ間で同 note を識別する portable ID |
| `title` | TEXT | ✓ | `''` | タイトル (空文字許容) |
| `kind` | TEXT | ✓ | `'doc'` | `doc` (汎用) / `chat` (拡張取り込み) / `bookmark` (ブクマ起点) / 等 |
| `tags_json` | TEXT |  | NULL | JSON `string[]` |
| `bookmark_id` | INTEGER |  | NULL | このノートのベース bookmark (NULL = フリーノート)。 SET NULL on bookmark 削除 |
| `bookmark_url` | TEXT |  | NULL | bookmark.url の冗長保存 (Hub 同期時の便宜 / ブックマーク削除後も URL は残す) |
| `source_kind` | TEXT |  | NULL | 取り込み元種別 (`chat` / 等) |
| `source_ref` | TEXT |  | NULL | 取り込み元参照 |
| `created_at` | TEXT | ✓ | UTC | |
| `updated_at` | TEXT | ✓ | UTC | ヘッダかブロック更新で bump |
| `owner_user_id` | TEXT |  | NULL | Hub 連携用 (NULL = ローカル自分) |
| `owner_user_name` | TEXT |  | NULL | |
| `shared_at` | TEXT |  | NULL | Hub 共有印 |
| `shared_origin` | TEXT |  | NULL | Hub URL |

Index: `idx_notes_updated` (updated_at DESC) / `idx_notes_kind` / `idx_notes_bookmark` (bookmark_id) / `idx_notes_source` (source_kind, source_ref)

## `note_blocks`
ノートを構成するブロック。 各ブロックも portable な UUID を持ち、 コメントの target アンカーに使う。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | DB 内部 PK (join 用) |
| `uuid` | TEXT | ✓ | — | UNIQUE。 マルチサーバで stable な block 識別子。 コメント `target_block_uuid` がここを指す |
| `note_id` | TEXT | ✓ | — | FK → `notes(id)` (UUID), ON DELETE CASCADE |
| `position` | REAL | ✓ | — | 並び順 (隣接 2 ブロックの平均で挿入できる) |
| `block_type` | TEXT | ✓ | `'text'` | (後述) |
| `text` | TEXT | ✓ | `''` | 本文 (markdown インライン込み) |
| `data_json` | TEXT |  | NULL | type 固有データ (JSON) |
| `created_at` | TEXT | ✓ | UTC | |
| `updated_at` | TEXT | ✓ | UTC | |

Index: `idx_note_blocks_note_position` (note_id, position) / `idx_note_blocks_uuid` (uuid)

### `block_type` enum
- `text` — 段落 (markdown インライン: `**bold**`, `*italic*`, `` `code` ``, `[link](url)`, `<span style="color:#hex">…</span>`)
- `heading_1` / `heading_2` / `heading_3` — 見出し
- `quote` — 引用
- `code` — コードブロック (`data_json.lang: string`)
- `mermaid` — Mermaid 図
- `table` — テーブル (`data_json.rows: string[][]` + `data_json.header: boolean`)
- `bullet_list` / `numbered_list` — リスト (`data_json.indent: number`)
- `todo` — チェックボックス (`data_json.checked: boolean`)
- `divider` — 水平線

## `note_comment_sets`
**1 (note × user) = 1 set**。 ノートに対する 1 ユーザのコメント集合。 マルチサーバでは別ユーザの set が複数並ぶ。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | TEXT | ✓ | — | **UUID** (set ID、 「ノートに対するコメント」 1 つの ID) |
| `note_id` | TEXT | ✓ | — | FK → `notes(id)` (UUID), ON DELETE CASCADE |
| `owner_user_id` | TEXT |  | NULL | NULL = ローカル自分。 Hub では Cernere user_id |
| `owner_user_name` | TEXT |  | NULL | |
| `created_at` | TEXT | ✓ | UTC | |
| `updated_at` | TEXT | ✓ | UTC | コメント追加 / 更新で bump |
| `shared_at` | TEXT |  | NULL | Hub 共有印 |
| `shared_origin` | TEXT |  | NULL | |

PK: `id` (UUID)
UNIQUE: `(note_id, owner_user_id)` — 1 ユーザは 1 ノートに 1 set
Index: `idx_note_comment_sets_note` (note_id)

## `note_comments`
1 行 1 コメント。 set 配下に N 件。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | TEXT | ✓ | — | **UUID** |
| `set_id` | TEXT | ✓ | — | FK → `note_comment_sets(id)`, ON DELETE CASCADE |
| `target_block_uuid` | TEXT |  | NULL | 特定 block へのアノテーション (NULL = note 全体への汎用コメント) |
| `position` | REAL | ✓ | — | set 内の表示順 |
| `text` | TEXT | ✓ | `''` | 本文 (markdown インライン) |
| `data_json` | TEXT |  | NULL | (拡張) |
| `created_at` | TEXT | ✓ | UTC | |
| `updated_at` | TEXT | ✓ | UTC | |

Index: `idx_note_comments_set_position` (set_id, position) / `idx_note_comments_target` (target_block_uuid)

## マルチサーバ共有モデル

各 user は同じ UUID の note データを各自のローカル DB に持つ。 つまり「ノート本体」 はマルチサーバ上で共有される 1 つの論理オブジェクトで、 user A の手元と user B の手元で同 UUID で同期される。

「ノートに対するコメント」 は **各 user の `note_comment_sets` 単位**で別 UUID で作られる。 ユーザ A は自分のコメント set (UUID Yₐ) を、 ユーザ B は自分の set (UUID Y_b) を持つ。 Hub は `note_id = X` の query で該当する set を **複数返す** ことができる (= 複数人のコメントを同時表示できる)。

実装は Phase 2 (本仕様書では schema のみ予約):
- `POST /api/multi/share` (kind=note) で note 本体 + 自分の set を Hub に push
- `GET /api/multi/notes/:note_id` で全コメント set の一覧を取得
- ローカル UI は「自分のコメントだけ」 / 「全員のコメント」 / 「特定 user のコメント」 を切替表示

## マイグレーション
PR rev1 の `notes` (INTEGER PK) は **空のとき drop+recreate**。 行があれば schema 不一致を warn して停止 (手動移行)。 PR rev1 の `note_blocks` も同様 (`uuid` 列追加)。
