# bookmark — Web ブックマーク

## 概要
URL + ローカル HTML スナップショット + AI 要約をセットで保存するブックマーク機能。 Chrome 拡張からの POST、 SPA からの URL 貼り付け、 PWA Web Share Target、 Hub からのダウンロードが入口。

## ユースケース
- 後で読み直したいページを HTML 込みで保存し、 元サイトが消えても残す
- AI 要約 + メモ + カテゴリで「あとで検索できる個人アーカイブ」 を作る
- アクセス回数 / 最終アクセスを基にした重要度ランキング (`accessed_desc` ソート、 おすすめタブの recommendation)
- Hub にシェアして他人 (LUDIARS Memoria 利用者) にも見せる

## 画面 / 入口
- `🗄 データベース` タブ → サブビュー `ブックマーク` (デフォルトビュー)
- `+ 追加` ボタン (`/api/bookmarks/from-url`)
- Chrome 拡張 (`extension/`) → `POST /api/bookmark` (HTML 込み)
- PWA Web Share Target → `GET /share?url=…` (`misc.ts` の `extractShareUrl`)
- Hub からのダウンロード: マルチビュー → 検索 → ダウンロード (`/api/multi/download` kind=bookmark)

## データ
- [bookmarks](../data/bookmark.md) — 主テーブル (URL / title / html_path / summary / status / owner_user_id …)
- [bookmark_categories](../data/bookmark.md) — many-to-many カテゴリ (CASCADE)
- [accesses](../data/bookmark.md) — アクセス履歴 1 件 1 行 (CASCADE)
- HTML 本文は **DB ではなく** `<DATA>/html/<file>.html` に格納 (DB には `html_path` のみ)
- ワードクラウド: [word_clouds](../data/wordcloud.md) (origin=bookmark / origin_bookmark_id, CASCADE)

## API
- [bookmark.md](../interface/bookmark.md) — `/api/bookmark` (拡張投稿) / `/api/bookmarks*` (CRUD + ページング + html / wordcloud / accesses) / `/api/bookmarks/from-url`
- 関連: [misc.md](../interface/misc.md) `/api/export` `/api/import` (HTML 込み JSON dump)
- 関連: [multi.md](../interface/multi.md) `/api/multi/share` (kind=bookmark) / `/api/multi/download`

## シェア可能か
**Hub-shareable** (明示的シェア操作のみ)

シェアされるフィールド:

| field | 内容 |
|---|---|
| `url` | 元 URL |
| `title` | ページタイトル |
| `summary` | AI 要約 (Claude) |
| `memo` | ユーザメモ |
| `categories[]` | カテゴリ名 |

シェア**されない**フィールド:
- `html_path` (HTML スナップショット本体)。 Hub 側にシェアされるのはあくまで URL + 要約 + メモであり、 オリジナル HTML はローカルに留まる。 ダウンロード側は受信時にあらためて URL を fetch (`fetchPageHtml`)。
- `accesses` (アクセス履歴)、 `access_count`, `last_accessed_at`
- ローカル独自の `id`, `status`, `error`

経路: **write-relay-only via Imperativus** (memory `feedback_memoria_online_flow.md`)。 `POST /api/multi/share` → ローカル DB の `shared_at` / `shared_origin` に印付け → Hub の `/api/shared/bookmarks` に POST (Cernere JWT 必須)。 直接書込みエンドポイントは PR #17 で削除済。

## プライバシー観点
- **個人データを保持するテーブル**: `bookmarks` (URL は閲覧履歴に等しい)、 `accesses` (いつ何を読み返したか)、 HTML スナップショットファイル (本文の完全コピー)。
- **LLM プロバイダに送る情報**: 要約タスク (`summarize`) で **HTML 本文のテキスト化結果**を Claude / OpenAI / Gemini / Codex (ユーザが LLM 設定で選択) に送る。 ローカル CLI 経由 (`claude` / `gemini` / `codex` バイナリ) のため、 ユーザ自身の API key スコープでだけ送信される。 ワードクラウド (`/api/bookmarks/:id/wordcloud`) も同じく本文を送る。
- **共有時に外部に出ない情報**: HTML スナップショット、 アクセス履歴、 ユーザメモのうち shareable 操作で除外したもの。
- **削除時の挙動**: `DELETE /api/bookmarks/:id` で `bookmarks` 行と CASCADE で `bookmark_categories` / `accesses` / `word_clouds` (origin_bookmark_id) を削除し、 ファイルシステム上の HTML も `unlinkSync`。 Hub にシェア済の場合は **Hub 側は残る** (現状自動 retraction なし)。
