# タブ: 未保存履歴

## 目的
過去 N 日にアクセスしたが未ブックマークの URL を一覧表示し、まとめて保存できるようにする。
**ローカルモード限定** — `online` モードでは tab そのものを非表示。

## 入力 API

| メソッド | パス | 用途 |
|---------|------|------|
| `GET` | `/api/visits/unsaved` | 当日のみ (期間 today を選んだとき) |
| `GET` | `/api/visits/suggested?days=N` | N 日前まで + 保存漏れスコア付き |
| `GET` | `/api/visits/unsaved/count` | バッジ用件数 |
| `POST` | `/api/visits/bookmark` | `{urls[]}` をサーバー fetch で保存 |
| `DELETE` | `/api/visits` | `{urls[]}` を履歴から削除 (保存はしない) |

## UI 要素

- ヘッダー
  - 期間 select: `今日のみ / 過去 7 日 / 過去 30 日 / 過去 90 日`
  - 「更新」ボタン
- アクションバー
  - 全選択チェック
  - 「N 件選択中」
  - 「選択をブックマークに保存」(緑)
  - 「選択を履歴から削除」(灰)
- リスト
  - 行クリックでチェック、再クリックで解除
  - 各行: ☐ / タイトル + 保存漏れバッジ (同ドメイン保存数) / URL + ドメイン + score / 最終アクセス時刻 + 訪問回数
  - score >= 10 (= 同ドメイン既保存あり) は左ボーダー強調 + 上位ソート
- 保存実行後の結果リスト
  - ✓ キュー投入 / 既存 / ✗ 失敗

## ロジック

- 期間が `today` の場合は `/api/visits/unsaved` を使用 (集計が UTC ではなく local date で完全一致)
- それ以外は `/api/visits/suggested` で score 降順、同 score なら最終アクセス降順
- 保存後、対応する `page_visits` 行は削除される (`bulkSaveUrls` 内)

## 制限

- ログイン必須ページは `fetchPageHtml` が失敗 → エラーで返る (Chrome 拡張ボタン推奨)
- `text/html` 以外 (PDF/JSON) は弾く
- 30 秒タイムアウト

## ロードマップ

- 推薦 ([#2](https://github.com/LUDIARS/Memoria/issues/2)) と同じくドメイン横断のクラスタ表示
- failed (server fetch ng) を分けて表示
- 「無視リスト」(ホスト or pattern) 永続化
