# Module: Visits (訪問履歴)

URL アクセス履歴の集計と「保存漏れサジェスト」。

## 目的
Chrome 拡張がタブ切替時に `/api/access` を叩き、ユーザーがどの URL を実際に読んでいるかをサーバーに残す。
未ブックマーク URL のうちブックマーク済ドメインに属するものは「保存漏れ」候補として浮上させる。

## 責務
- `page_visits` テーブルへの URL 単位の upsert (`first_seen_at`, `last_seen_at`, `visit_count`)
- 既ブックマーク URL の場合は `accesses` への行追加 + `bookmarks.access_count++` も実施
- 期間別の未保存 URL 一覧 + 保存漏れスコア計算
- `online` モードでは関連エンドポイントを完全停止 (privacy)

## API

| Path | 説明 |
|------|------|
| `POST /api/access` | local では upsert + ブックマークなら recordAccess; online では no-op |
| `GET /api/visits/unsaved` | 当日 (local date) 未保存のみ |
| `GET /api/visits/suggested?days=N` | 過去 N 日 + score 計算 |
| `GET /api/visits/unsaved/count` | バッジ用件数 |
| `POST /api/visits/bookmark` | `{urls[]}` を bulkSaveUrls で fetch + 保存 |
| `DELETE /api/visits` | `{urls[]}` を履歴から削除 |

## 保存漏れスコア (`listSuggestedVisits`)

```
score = same_domain_bookmarks * 10
      + same_path_prefix_bookmarks * 8
      + min(visit_count, 20) * 2
```

- `same_domain_bookmarks`: ブックマーク中に同ドメインがいくつあるか (例: `zenn.dev` で 5 件)
- `same_path_prefix_bookmarks`: path の先頭セグメントが一致する保存数 (例: `zenn.dev/foo/...` で 1, それ以外なら 0)
- `visit_count`: 自身の訪問回数 (上限 20 で頭打ち)

## ソート

`score DESC, last_seen_at DESC`

## 制限

- ローカル日付の判定は SQLite の `date(?, 'localtime')` (タイムゾーンは OS)
- `online` モードでは page_visits への書き込みも行わない (privacy)
- domain 抽出は `new URL().hostname` で失敗するものは null → スコア計算から除外

## ロードマップ

- 同ドメインクラスタ表示 (推薦タブと統合)
- ホスト名の編集距離 (`docs.` ⇄ `developer.`) もスコアに加味
- 訪問頻度の時系列グラフ (傾向タブと統合)
