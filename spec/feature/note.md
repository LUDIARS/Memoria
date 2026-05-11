# note — ノート (markdown ライク WYSIWYG ドキュメント)

## 概要
esa / DocBase ライクな WYSIWYG markdown エディタ。 Notion 同様 1 行 = 1 ブロックのブロックベース構造で、 markdown 書式 + フォントの色変え + テーブル + Mermaid に対応。

ノート ID は **UUID** で管理し、 マルチサーバ間で同じ note を一意に識別できる。 ノートには 2 種類ある:

- **通常ノート** (`kind='doc'` / `'chat'` / `'meeting'` / …)
  - markdown ブロックの線形フロー (text / heading / quote / list / code / mermaid / table / todo / divider)
  - bookmark との紐付けは **無し** (後から付けることもできない)
- **ブックマークノート** (`kind='bookmark'`)
  - 元 bookmark の HTML スナップショットを `<iframe sandbox>` でレンダリング (= canvas)
  - canvas 上に **フローティングテキストブロック** (`block_type='floating_text'`) をオーバーレイ配置
  - 各フローティングは座標 (x, y) + (任意で) HTML 内テキスト範囲アンカーを持つ
  - これらが「ブックマークしたページに対するコメント / 注釈」 として機能する

コメントは「ノートに対する 1 ユーザの集合」 を 1 単位 (set) として別 UUID 名前空間で管理する (Phase 1 はローカル自分の set のみ、 Phase 2 でマルチユーザ)。

## ユースケース
- 作業ログ / 議事録 / 思考整理 / 設計メモを WYSIWYG で書く
- ブクマしたページに対する個人の解説 / 補足 / 反論メモ (= 「読書メモ」 風)
- AI とのチャット (Gemini / Claude / ChatGPT) を extension 経由で Note 化
- マルチサーバで他人と同じ note を共有しつつ、 **コメントは各自で別管理**して横並びで見比べる

## 画面 / 入口
- **PC 表示の左端タブ「📓 ノート」**
- ノート一覧 (左サイドバー) + 詳細 (中央) + コメント (右ペイン)
- 通常ノートの詳細:
  - 上: タイトル + タグ + 削除ボタン + 「📍 フローティングを追加」 ボタン
  - 中央: 線形ブロックエディタ + その上に **フローティング overlay layer**
    (絶対配置の `floating_text` を blocks-wrap に重ねて表示)
  - 末尾アクション: 「+ ブロックを追加」 (text を追加) と 「+ 特殊ブロック」
    (text 含む全種別ピッカー、 mobile では bottom-sheet)
  - 右: コメントパネル (テキスト形式のコメント、 自分の set / 他者の set 切替)
- モバイル (≤760px) の挙動:
  - 左ノート一覧は off-canvas drawer 化。 ☰ で開閉、 backdrop タップで閉、
    ノートを開いた瞬間に自動で閉じる (bookmark UI と同じ感覚)
  - 「+ 特殊ブロック」 メニューは bottom-sheet 表示 (max-height 70vh + ヘッダ ✕)
- ブックマークノートの詳細:
  - 上: タイトル + タグ + 元 URL バッジ + 削除ボタン
  - 中央: `<iframe sandbox>` で bookmark HTML を canvas として表示 + その上に floating_text ブロックを絶対配置オーバーレイ
  - 操作: canvas クリックで現在位置に floating_text 挿入 / floating ブロックをドラッグで再配置 / 削除 / 編集
  - 右: コメントパネル (canvas 上 floating の一覧 + 通常ノートの set コメントと統合表示)
- 入口:
  - 新規 (空の通常ノート): 「+ 新規ノート」 ボタン
  - 新規 (bookmark ベース): 「🔖 bookmark から」 → ピッカーで bookmark 選択 → `kind='bookmark'` で生成
  - bookmark 詳細画面 (将来) の「📝 このページにノート」 ボタン → 既存 bookmark note があれば開く / なければ新規
  - extension chat 取り込み: `/api/notes/from-chat` で生成 → 自動でエディタを開く
  - extension Notion 取り込み: `notion.so` / `notion.site` で 黒いボタン → ページ scrape → `/api/notes/from-notion` で生成

## bookmark / note 埋め込み (Notion 風)
通常ノートのスラッシュメニューから:
- **🔖 Bookmark を挿入** → bookmark picker → `bookmark_embed` ブロックがカード表示で挿入。 「📂 キャッシュを開く」 リンクで `/api/bookmarks/:id/html` (Web アーカイブ) を別タブで表示。 挿入時に対象 bookmark の `bookmarks` 行が必須 (= note 経由でも常にローカル bookmark が存在する保証)
- **📓 Note を挿入** → note picker → `note_link` ブロックがカード表示で挿入。 クリックで対象 note にナビゲート

マルチサーバ download 時 (Phase 2): `bookmark_embed` を含む note を受信したら、 `bookmark_url` で受信側 DB を検索 → 既に bookmark 済ならその local id に置換、 未保存なら **Hub から bookmark 本体も同時に download** して bookmark + URL HTML を取得し、 新しく付与された local id で `data_json.bookmark_id` を更新する。 これにより note を共有しても embed 表示が常にローカルキャッシュで成立する。

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
| type | 用途 | 使える場所 | データ |
|---|---|---|---|
| `text` | Markdown 段落 | 通常ノート | `text` (markdown インライン) |
| `heading_1..3` | 見出し | 通常ノート | `text` |
| `quote` | 引用 | 通常ノート | `text` |
| `code` | コードブロック | 通常ノート | `text` + `data_json.lang` |
| `mermaid` | Mermaid 図 | 通常ノート | `text` |
| `table` | テーブル | 通常ノート | `data_json.rows` + `data_json.header` |
| `canvas` | **お絵描きキャンバス** (SVG ベース、 ペン / 消しゴム / 6 色 + カスタム / 5 段階太さ / Undo / 全消去) | 通常ノート | `data_json.paths[]` (`points`="x,y x,y …" + `color` + `width`) + `canvasWidth?/canvasHeight?` |
| `bullet_list` / `numbered_list` | リスト | 通常ノート | `text` + `data_json.indent` |
| `todo` | チェックボックス | 通常ノート | `text` + `data_json.checked` |
| `divider` | 水平線 | 通常ノート | (空) |
| `floating_text` | **フローティングテキスト** (自由配置の絶対座標注釈) | **両方** (bookmark canvas overlay / 通常ノートの blocks-wrap overlay) | `text` + `data_json.x/y/width?/height?/color?/anchor?` |
| `bookmark_embed` | **bookmark 埋め込みカード** (Notion 風) | 通常ノート | `data_json.bookmark_id?/bookmark_url/title?/summary?/image?/site_name?` (`bookmark_id=null` = ad-hoc URL カード = Notion `/bookmark` 同等) |
| `note_link` | **note→note 内部リンクカード** | 通常ノート | `data_json.note_id/title?` |

> 全 block 共通: `data_json.bgColor` (CSS 色) を持つと block の背景色になる (Notion ライク装飾)。

### Inline mention chip

`text` block / heading / list / quote の本文中に **inline chip** として bookmark / note を埋め込める (block 単位の `bookmark_embed` / `note_link` カードとは別経路)。 sentence の流れに沿わせたい時はこちら。

- HTML 形: `<a class="memoria-mention memoria-mention-bookmark" data-bookmark-id="N">タイトル</a>`
- HTML 形: `<a class="memoria-mention memoria-mention-note" data-note-uuid="...">タイトル</a>`
- selection toolbar の 🔖 / 📓 から開く inline picker で挿入する。 sanitize は class + data-* + href のみ残す。

### Notion 風 URL preview card (`/bookmark`)

block menu の **🌐 URL を埋め込む** から URL を入力すると、 server の `POST /api/notes/url-preview` が OG metadata (title / description / og:image / og:site_name) を取り、 `bookmark_embed` block (image 付き) として挿入する。 既存 bookmark 行と URL が一致した場合は `data_json.bookmark_id` をそちらに紐付け。 そうでなければ `bookmark_id=null` の ad-hoc カードとなり、 bookmark テーブルには登録されない。

#### metadata の取得経路 (Plan B: extension scrape 優先 → server fetch fallback)

URL preview metadata は以下の優先順で解決される。 response の `source` フィールドにどの経路を使ったかが入る。

1. **`extension-scrape`** — extension が既に該当 URL を bookmark 経路 (`POST /api/bookmark`) で送ってきていた場合、 その時に rendered DOM から抽出した og:* が `page_metadata` テーブルにキャッシュされている。 SPA でも JS 描画後の DOM を捕捉できるので一番高信頼。
2. **`bookmark-row`** — 上記キャッシュは無いが bookmark 行は存在する場合、 title + summary だけで簡易カードを返す (画像なし)。
3. **`server-fetch`** — どのキャッシュにも該当が無ければ server-side で OG fetch する (`fetchUrlPreview`)。 SSR ページなら成功、 SPA shell だと空に近い結果になる。

extension 側の Notion 取り込み (`/api/notes/from-notion`) でも `notion-bookmark-block` を `kind: 'bookmark'` (url + title? + caption? + image?) として送り、 server 側で同じ `bookmark_embed` 形に正規化して保存する。

## コメント仕様
- 1 (note × user) で 1 set。 set 自体が UUID を持つ (`note_comment_sets.id`)
- set 配下に複数コメント (`note_comments`、 各コメントも UUID + position)
- コメントは **note 全体宛て** (`target_block_uuid = NULL`) または **特定 block 宛て** (`target_block_uuid = <block.uuid>`) のどちらか
- ローカル単独運用では set は 1 個 (= 自分の set)
- マルチサーバでは複数 user 分の set が並列で存在し、 横断クエリで全員のコメントが取れる

### bookmark canvas との関係
ブックマークノートでは canvas 上の **floating_text ブロック**が「ブックマーク済ページに対する注釈 / コメント」 として機能する。 これらは note のブロック (`note_blocks`) として保存され、 note を共有する全ユーザに見える共通の注釈となる。

一方、 **per-user の comment_set / note_comments** は別レイヤーで、 「他人のノートに自分のコメントを乗せる」 用途で使う (Phase 2)。 多人数で同じブックマークノートを共有する場合:

- floating_text ブロック = ノート所有者の注釈 (= 「公式」)
- note_comments の floating コメント (Phase 2) = 各個人の注釈 (= 「私見」)

どちらも canvas 上にオーバーレイ表示するが、 編集権限とライフサイクルが異なる。

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
