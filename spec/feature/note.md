# note — ノート (markdown ライク WYSIWYG ドキュメント)

## 概要
esa / DocBase ライクな WYSIWYG markdown エディタ。 Notion 同様 1 行 = 1 ブロックのブロックベース構造で、 markdown 書式 + フォントの色変え + テーブル + Mermaid に対応。

ノート ID は **UUID** で管理し、 マルチサーバ間で同じ note を一意に識別できる。 ノートには **ベースとして bookmark を選択でき**、 bookmark したページに対するコメント / 補足 / 思考メモを書き込める。 コメントは「ノートに対する 1 ユーザの集合」 を 1 単位 (set) として別 UUID 名前空間で管理する。

## ユースケース
- 作業ログ / 議事録 / 思考整理 / 設計メモを WYSIWYG で書く
- ブクマしたページに対する個人の解説 / 補足 / 反論メモ (= 「読書メモ」 風)
- AI とのチャット (Gemini / Claude / ChatGPT) を extension 経由で Note 化
- マルチサーバで他人と同じ note を共有しつつ、 **コメントは各自で別管理**して横並びで見比べる

## 画面 / 入口
- **PC 表示の左端タブ「📓 ノート」**
- ノート一覧 (左サイドバー) + 詳細 (右ペイン)
- 詳細ペインの構成:
  - 上: タイトル + タグ + ベース bookmark (あれば URL / タイトル表示) + 削除ボタン
  - 中央: ブロックエディタ
  - 右: コメントパネル (自分の set / 他者の set 切替)
- bookmark 詳細画面の「📝 ノートを書く」 ボタン → 既存 note があれば開く、 なければ新規作成
- extension chat 取り込み: `/api/notes/from-chat` で生成 → 自動でエディタを開く

## データ
- [notes](../db/note.md) — ヘッダ (UUID PK, bookmark_id 紐付け, Hub 連携カラム)
- [note_blocks](../db/note.md) — ブロック (UUID + position REAL)
- [note_comment_sets](../db/note.md) — 1 (note × user) = 1 set (UUID PK)
- [note_comments](../db/note.md) — set 配下の個別コメント

## API
- [note.md](../api/note.md) — `/api/notes*` (UUID パス) + `/api/notes/:uuid/comment-sets*` + `/api/notes/from-chat`
- 関連: [bookmark.md](bookmark.md) (note のベース)
- 関連: [external-chat.md](external-chat.md) (`/api/notes/from-chat` 副作用)

## ブロック種別
| type | 用途 | データ |
|---|---|---|
| `text` | 段落 | `text` (markdown インライン) |
| `heading_1..3` | 見出し | `text` |
| `quote` | 引用 | `text` |
| `code` | コードブロック | `text` + `data_json.lang` |
| `mermaid` | Mermaid 図 | `text` |
| `table` | テーブル | `data_json.rows` + `data_json.header` |
| `bullet_list` / `numbered_list` | リスト | `text` + `data_json.indent` |
| `todo` | チェックボックス | `text` + `data_json.checked` |
| `divider` | 水平線 | (空) |

## コメント仕様
- 1 (note × user) で 1 set。 set 自体が UUID を持つ (`note_comment_sets.id`)
- set 配下に複数コメント (`note_comments`、 各コメントも UUID + position)
- コメントは **note 全体宛て** (`target_block_uuid = NULL`) または **特定 block 宛て** (`target_block_uuid = <block.uuid>`) のどちらか
- ローカル単独運用では set は 1 個 (= 自分の set)
- マルチサーバでは複数 user 分の set が並列で存在し、 横断クエリで全員のコメントが取れる

### マルチサーバ表示モード
- **自分のコメントのみ**: 自 user_id の set だけ表示 (デフォルト)
- **全員**: note 配下の全 set を user 別に色分けで重ねて表示
- **特定 user**: 1 user の set だけ表示

(マルチサーバ実装は Phase 2 — schema は予約済、 UI はローカル set のみで MVP)

## シェア可能か
**Phase 1: local-only**

ノート本体 / ブロック / コメント set / コメントすべてに `owner_user_id` / `shared_at` / `shared_origin` のカラムは予約済 (Phase 2 で Hub 連携)。 思考メモを含む前提なので、 Phase 1 では Hub 共有経路を出さない。

**Phase 2 (予定):**
- `POST /api/multi/share` (kind=`note`) → note 本体 + 自分の set を Hub に push
- `GET /api/multi/notes/:note_uuid` → 全 user の set を取得 (= 複数人のコメントを同時表示)
- 受信側は **読み取り専用** (downloaded_origin 印付け、 編集は upstream owner のみ)

## プライバシー観点
- **個人データを保持するテーブル**: `notes` / `note_blocks` (本文)、 `note_comment_sets` (Hub 連携時 owner_user_id)、 `note_comments` (本文)。 機微度ほぼ最高 (日記同等)。
- **LLM プロバイダに送る情報**: 機能自体は LLM 呼び出しなし。 from-chat 経由で AI の出力をローカルに pull するだけ。
- **共有時に外部に出ない情報**: Phase 1 は全部。 Phase 2 でも `owner_user_id` が NULL のコメント / 未シェア set は Hub に出ない。
- **削除時の挙動**:
  - `DELETE /api/notes/:uuid` → CASCADE で `note_blocks` + `note_comment_sets` + `note_comments` を削除
  - `DELETE /api/notes/:uuid/comment-sets/:setUuid` → CASCADE で配下コメント削除
  - bookmark 削除時: `notes.bookmark_id` は SET NULL (note 自体は残る、 `bookmark_url` で履歴は保てる)

## 関連
- [extension.md](extension.md) — chat 取り込みボタン dispatch
- [bookmark.md](bookmark.md) — note のベース
