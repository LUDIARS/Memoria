# visit — ブラウジング履歴 + recommendation

## 概要
Chrome 拡張 (`POST /api/access`) や Legatus DNS / SNI tap (`POST /api/visits/external`) からブラウジング履歴を吸い上げ、 URL ごとの集計 (`page_visits`) + 個別イベント (`visit_events`) に分離。 未保存 URL からブクマ候補 / おすすめ生成。

## ユースケース
- Chrome 拡張入れたら自動でアクセス履歴が貯まる → 後で重要なものをブクマ化
- 「今日見た中で保存してないやつ」 (`/api/visits/unsaved`) を逐次確認 → bulk save
- おすすめタブで再訪 / 他人ブクマ等のレコメンド (`/api/recommendations`)
- DNS / SNI tap (Legatus) でブラウザ拡張なしのデバイス (iPhone 等) もカバー

## 画面 / 入口
- `🗄 データベース` タブ → `ブクマ未保存`
- `✨ おすすめ` タブ → `/api/recommendations`
- 傾向タブ → `/api/trends/visit-domains` 等
- 作業ログタブ (`📝 ログ`) → `/api/worklog/browsing`

## データ
- [page_visits](../data/visit.md) — URL (PK) / first_seen_at / last_seen_at / visit_count
- [visit_events](../data/visit.md) — URL / domain / visited_at / device_label / device_os / source (browser/dns/sni)
- 関連: [page_metadata](../data/page.md) (lazy fetch)、 [domain_catalog](../data/page.md)、 [recommendation_dismissals](../data/dig.md)

## API
- [visit.md](../interface/visit.md) — `/api/access` (拡張ping) / `/api/visits/unsaved` `/api/visits/suggested` `/api/visits/unsaved/count` / `/api/visits/bookmark` (bulk save) / `/api/visits/external` (DNS/SNI) / `/api/visits/external/stats`
- 関連: [misc.md](../interface/misc.md) `/api/recommendations*` / `/api/trends/*`、 `/api/extension/status`

## シェア可能か
**local-only**

ブラウジング履歴は丸ごとローカル限定。 個別 URL を bookmark に昇格させてはじめてシェア可能になる。

## プライバシー観点
- **個人データを保持するテーブル**: `page_visits` / `visit_events` (個人情報密度最高クラスのブラウジング履歴)。 `device_label` (Tailscale ホスト名) と `device_os` も付く。
- **LLM プロバイダに送る情報**: visit 自体は LLM 非依存。 ただし `page_metadata` の summary 生成 (タスク `page_summary`、 Sonnet default) で **訪問 URL の HTML 本文** が LLM に流れるケースがある。 日記生成にも当日 URL タイムラインが prompt に入る。
- **共有時に外部に出ない情報**: 全部。 visit_events.source (DNS/SNI) も外には出ない。
- **削除時の挙動**: `DELETE /api/visits` (urls[] 指定) で `page_visits` 行のみ削除 (`visit_events` の per-event 行は残る)。 `recommendation_dismissals` は手動 clear (`DELETE /api/recommendations/dismissals`)。 retention は手動 (古い `visit_events` の自動 GC は無し)。
