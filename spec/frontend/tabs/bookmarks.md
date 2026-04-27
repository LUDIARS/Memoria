# タブ: ブックマーク

## 目的
保存済ブックマークの一覧表示、検索、メモ編集、エクスポート/インポート。Memoria のホームタブ。

## 入力 API

| メソッド | パス | 用途 |
|---------|------|------|
| `GET` | `/api/bookmarks?category=&sort=` | 一覧 |
| `GET` | `/api/bookmarks/:id` | 詳細 |
| `GET` | `/api/bookmarks/:id/accesses` | アクセス履歴 |
| `GET` | `/api/categories` | サイドバーのカテゴリ一覧 |
| `PATCH` | `/api/bookmarks/:id` | メモ・カテゴリ更新 |
| `POST` | `/api/bookmarks/:id/resummarize` | 再要約 |
| `DELETE` | `/api/bookmarks/:id` | 削除 |
| `POST` | `/api/export` | 選択 (or 全件) を JSON ダウンロード |
| `POST` | `/api/import` | JSON 取り込み |

## UI 要素

### サイドバー
- カテゴリ list、各項目に件数バッジ
- 「すべて」で絞り込み解除

### カード (メイン領域)
- title (大文字、太字)
- url (色付き)
- summary (3 行クリップ)
- category チップ
- 左下: 追加日、右下: アクセス数
- 状態: `pending` (要約中), `error` (要約失敗) を補助テキスト
- 左上にチェックボックス (複数選択 → エクスポート)

### 詳細パネル (右ペイン、選択時のみ表示)
- タイトル + URL リンク
- メタ情報: 追加日 / 最終アクセス / アクセス回数 / status
- 要約 (read-only)
- カテゴリ (カンマ区切り編集可)
- メモ (textarea)
- アクション: 保存 / 再要約 / 保存 HTML を別タブで開く / 削除
- アクセス履歴 (時系列)

### ヘッダー
- ソート select (`created_desc | created_asc | accessed_desc | accessed_asc | title_asc`)
- 検索 input (タイトル / URL / 要約 / カテゴリへの substring 検索、フロント側フィルタ)

## 動作

- `state.search` 変更時は API 呼ばずローカル filter
- カテゴリ切替・ソート変更は `/api/bookmarks` を再 GET
- 選択チェック >0 件で `bulkbar` を表示し「選択をエクスポート」「クリア」ボタンを出す
- 詳細パネルで「再要約」を押すと `pending` に戻り、ヘッダーバッジが「要約待ち」を表示

## 制限

- カテゴリの並び順カスタムはなし (件数 desc → 名前 asc 固定)
- `online` モードでは保存・編集すべて `Authorization` 必須

## ロードマップ

- 一括カテゴリ付与
- タグ機能 (カテゴリと別に自由タグ)
- フィルタの永続化 (URL クエリ)
