# note — ノート (markdown ライク WYSIWYG ドキュメント)

## 概要
esa / DocBase ライクな WYSIWYG markdown エディタ。 Notion 同様 1 行 = 1 ブロックのブロックベース構造でテキストを管理し、 markdown 書式 + フォントの色変え + テーブル + Mermaid に対応。

## ユースケース
- 作業ログ / 議事録 / 思考整理 / 設計メモを WYSIWYG で書く (markdown 知識不要)
- AI とのチャット (Gemini / Claude / ChatGPT) 結果を extension 経由で Note にまとめて保存
- ブロックベースなので部分編集 / 並べ替え / 種類変更が高速 (`/` でブロック種別切り替え)
- Mermaid でフローチャート / シーケンス図を埋め込み、 表で比較メモを取る

## 画面 / 入口
- `📝 ノート` タブ (新設) → 一覧 + 検索 + 新規作成
- ノート詳細: 左ペインに目次 (見出しブロック)、 右ペインにブロック編集
- extension 経由: 「AI チャットを Note 化」 ボタン → `/api/notes/from-chat` で生成 → 自動で詳細画面に遷移

## データ
- [notes](../db/note.md) — ヘッダ (title / kind / tags / source / Hub メタ)
- [note_blocks](../db/note.md) — ブロック (type / position / text / data_json)

## API
- [note.md](../api/note.md) — `/api/notes*` (CRUD + ブロック編集 + reorder + `/from-chat`)
- 関連: [bookmark.md](bookmark.md) (extension の保存ボタンと並列で動く)
- 関連: [external-chat.md](external-chat.md) (`/api/notes/from-chat` は副作用で `external_chat_messages` にも message 単位 insert)

## ブロック種別
| type | 用途 | データ |
|---|---|---|
| `text` | 段落 | `text` (markdown インライン) |
| `heading_1..3` | 見出し | `text` |
| `quote` | 引用 | `text` |
| `code` | コードブロック | `text` + `data_json.lang` |
| `mermaid` | Mermaid 図 | `text` (Mermaid ソース) |
| `table` | テーブル | `data_json.rows: string[][]` + `data_json.header: boolean` |
| `bullet_list` / `numbered_list` | リスト | `text` + `data_json.indent: number` |
| `todo` | チェックボックス | `text` + `data_json.checked: boolean` |
| `divider` | 水平線 | (空) |

インライン書式は markdown 標準 (`**bold**`, `*italic*`, `` `code` ``, `[link](url)`) + 文字色は `<span style="color:#hex">…</span>` (allowlist サニタイザ通過のみ)。

## シェア可能か
**local-only** (Phase 1)

ノートには思考片 / 個人メモが含まれる前提。 Hub 共有経路は Phase 2 で実装予定 (現状 owner_user_id / shared_at カラムは予約のみ)。

## プライバシー観点
- **個人データを保持するテーブル**: `notes` (タイトル / 思考メモ全般)、 `note_blocks` (本文)。 機微度はほぼ最高 (日記同等)。
- **LLM プロバイダに送る情報**: ノート機能自体は LLM 呼び出しなし。 ただし `/api/notes/from-chat` 経由で AI とのチャット内容そのものが Note に取り込まれる場合あり (この時点で LLM へは送らない、 既に AI 側にあるデータをローカルに pull するだけ)。
- **共有時に外部に出ない情報**: 全部 (Phase 1 は Hub 共有なし)。
- **削除時の挙動**: `DELETE /api/notes/:id` で `notes` 行 + CASCADE で `note_blocks` を削除。 `external_chat_messages` 側 (もし from-chat で同時 insert したもの) は別途残る (削除したいなら `DELETE FROM external_chat_messages WHERE …`)。

## 関連
- [extension.md](extension.md) — chat 取り込みボタンの dispatch ルール
