# dig — 調査セッション (deep research)

## 概要
ユーザクエリを起点に検索エンジン → AI 要約 → ソース付きレポートを生成する deep research 機能。 Phase 0 (raw SERP) → Phase 1 (preview) → Phase 2 (deep) の 3 段で完成形に向かう。

## ユースケース
- 「○○について最新動向まとめて」 とぶっこむと、 検索 → サイト読込 → 要約 → ソース URL リスト付きレポートが返る
- セッション結果の URL を一括ブクマ化 (`/api/dig/:id/save`)
- セッション間でテーマを共有してリストアップ (`?theme=...`)
- セッション結果から辞書エントリ追加 / ワードクラウド生成

## 画面 / 入口
- `🔎 ディグる` タブ → クエリ欄 + 検索エンジン選択 + テーマ
- セッション一覧 → 各セッション詳細
- 関連: ブクマ詳細から「このページから dig」 / 日記から「この日の dig」

## データ
- [dig_sessions](../db/dig.md) — query / status / result_json (Phase 2) / preview_json (Phase 1) / raw_results_json (Phase 0) / theme / owner / shared
- [recommendation_dismissals](../db/dig.md) — おすすめタブで dismissed した URL
- 派生: [word_clouds](../db/wordcloud.md) (origin=dig)、 [dictionary_links](../db/dictionary.md) (source_kind='dig')

## API
- [dig.md](../api/dig.md) — `/api/dig` (POST queue / GET 一覧) / `/api/dig/:id` / `/api/dig/:id/save` (URL 一括ブクマ化) / `/api/dig/themes` / `/api/dig/engines`
- 関連: [multi.md](../api/multi.md) `/api/multi/share` (kind=dig) / `/api/multi/download`

## シェア可能か
**Hub-shareable** (明示的シェア操作のみ)

シェアされるフィールド:

| field | 内容 |
|---|---|
| `query` | ユーザクエリ |
| `status` | `done` / `error` 等 |
| `result` (JSON) | Phase 2 の要約 + sources[] (url, title, snippet, topics) |

シェアされない:
- `raw_results_json` (raw SERP)、 `preview_json` (中間)
- `owner_user_id` 自身
- セッション派生のローカル ワードクラウド / 辞書リンク

経路: **write-relay-only via Imperativus**。 `POST /api/multi/share` (kind=dig) → `markDigShared` → Hub `/api/shared/digs`。

## プライバシー観点
- **個人データを保持するテーブル**: `dig_sessions` (クエリ自体がリサーチ意図を直接示す)。
- **LLM プロバイダに送る情報**: クエリ + 検索エンジン (DuckDuckGo / Bing / Yahoo / etc.) からの SERP + 各 URL の本文を、 タスク `dig` / `dig_preview` (Claude / Gemini / Codex / OpenAI のいずれか) に送る。 全文ではなく snippet + 上位ソースに限定するが、 クエリ自体は完全な形で LLM に渡る。
- **共有時に外部に出ない情報**: raw SERP、 preview、 dismiss した URL リスト、 派生ワードクラウド。
- **削除時の挙動**: `DELETE /api/dig/:id` で行を削除。 派生 `word_clouds.origin_dig_id` / `dictionary_links` (source_kind='dig') は **orphan として残る** (UI 側で「セッション削除済」 として handle)。 Hub シェア済は残置。
