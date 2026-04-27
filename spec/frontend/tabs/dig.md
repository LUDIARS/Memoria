# タブ: ディグる (Dig — Deep Research)

## 目的
特定トピックを Web 全体から掘り下げる。テキストを入力 → claude が WebSearch+WebFetch を使ってソースを収集 → リスト + 放射状グラフで可視化 → 気になるソースを選んでブックマーク化。

## 入力 API

| メソッド | パス | 用途 |
|---------|------|------|
| `POST` | `/api/dig` | `{query}` → セッション作成 + キュー投入、ID 返却 |
| `GET` | `/api/dig` | 履歴 30 件 |
| `GET` | `/api/dig/:id` | セッション詳細 (status / result_json) |
| `POST` | `/api/dig/:id/save` | `{urls[]}` を bulkSaveUrls で保存 |

## UI 要素

- 入力欄: 大きい text input + 「ディグる」ボタン
- 履歴 pill 行: 過去のディグセッション (status 別カラー: pending / done / error)
- 結果セクション
  - サマリ (claude 生成、1〜3 段落)
  - 放射状グラフ (中心 = クエリ、外周 = ドメイン)
  - ソースカード (CSS Grid `minmax(360px, 1fr)`)
    - チェックボックス + タイトル
    - URL リンク
    - claude が書いた snippet
    - topic タグ
- アクションバー: 「N 件選択中」 + 「選択をブックマーク化」

## ロジック

- POST で id を取得 → 5 秒ポーリングで status が `done`/`error` になるまで待つ
- 完了時は 8〜12 件のソース JSON を `dig_sessions.result_json` から読んで表示
- 履歴 pill クリックで過去セッション再表示

## グラフ

- 円形配置 (`(2π * i / N) - π/2` で 12 時方向から時計回り)
- 中心ノード = クエリ (24 文字クリップ)
- 周辺ノード = ドメイン名 (`new URL().hostname` から `www.` 剥がす)
- 線 = 中心 → 各ノード (関連度線は v0 では未実装)

## 制限

- claude CLI で `--allowedTools WebSearch,WebFetch` が許可された環境のみ
- 1 セッション 5〜10 分 (claude のレスポンス時間)
- 結果が JSON で返らない場合は status=error

## ロードマップ

- ソース間の topic 共有度でエッジを描画 (force-directed)
- ノードクリックで該当ソースカードへスクロール
- セッション間横断の topic クラスタ可視化
