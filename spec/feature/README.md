# `spec/feature/` — 機能仕様 (シェア可能性 + プライバシー注記付き)

このフォルダは Memoria の **機能単位** のドキュメント。 1 機能 1 ファイルで「何のための機能か / どこから入るか / どのテーブル / どの API / Hub にシェアできるか / 個人データはどこに溜まるか」 を簡潔にまとめる。

`spec/db/` (テーブル) と `spec/api/` (HTTP) を **横串で読み解くインデックス**として機能する。

## 共有レベル
- ✓ **Hub-shareable** — `/api/multi/share` 経由で Hub に共有可能 (明示的シェア操作のみ、 read-public + write-relay-only via Imperativus)
- 🏠 **local-only** — Hub 共有経路なし。 ローカル個人 DB 限定
- 📊 **derived-only** — 派生統計値のみ (raw データは出ない)

## 機能一覧

| 機能名 | ファイル | 共有レベル | 備考 |
|---|---|---|---|
| Web ブックマーク | [bookmark.md](bookmark.md) | ✓ | url + title + summary + memo + categories のみ。 HTML スナップショットは出ない |
| 本棚 / 新刊 / 読書サジェスト | [books.md](books.md) | 🏠 | 蔵書・感想・読了履歴はローカル保存。サジェスト生成時だけ読書傾向を設定済み LLM へ送る |
| 調査セッション (Dig) | [dig.md](dig.md) | ✓ | query + Phase 2 result のみ。 raw SERP / preview は出ない |
| 個人辞書 | [dictionary.md](dictionary.md) | ✓ | term + definition + notes。 出典 (dictionary_links) は出ない。 受信側は `term (@owner)` で namespace 化 |
| ワードクラウド | [wordcloud.md](wordcloud.md) | 🏠 | 元 bookmark / dig のシェア経由で各自再生成 |
| 日次自動日記 | [diary.md](diary.md) | 🏠 | 個人情報密度最高。 シェア経路なし |
| 週次レポート | [weekly.md](weekly.md) | 🏠 | 日記と同じ理由 |
| ドメイン辞書 | [domain-catalog.md](domain-catalog.md) | 🏠 | ブラウジング履歴の蒸留 |
| タスク管理 | [task.md](task.md) | ✓ | Hub ではなく **Actio** に共有 (`/api/tasks/:id/share/actio`) |
| エージェント実行 | [agent.md](agent.md) | 🏠 | 絶対パス + プロンプト + コードログを含む |
| エージェント実行 (Concordia) | [concordia-runner.md](concordia-runner.md) | 🏠 | agent.md の代替経路: wt タブ + Lictor inject。 `llm.task_runner=concordia` で有効 |
| 作業場所 + presence | [workplace.md](workplace.md) | ✓ | カタログ (lat/lng + 名前 + tags) と presence (enter/leave) の 2 系統 |
| 実装自慢ノート | [implementation-notes.md](implementation-notes.md) | ✓ | `shareable=1` フラグ必須の二段階フロー |
| 食事写真 + 栄養推定 | [meal.md](meal.md) | 🏠 | 健康情報の機微度を考慮した意図的 local-only |
| GPS 軌跡 | [gps.md](gps.md) | 🏠 | Tailscale 経由が推奨。 workplace presence は別系統で出る |
| ブラウジング履歴 | [visit.md](visit.md) | 🏠 | bookmark に昇格させて初めてシェア可能 |
| PWA Web Push | [push-notification.md](push-notification.md) | 🏠 | 端末固有の機微鍵を含む |
| Amazon Echo / Alexa連携 | [amazon-echo.md](amazon-echo.md) | 🏠 | 本文はローカル保持。Amazonへはopt-inで未読件数だけ送信 |
| Memoria Hub プレゼンス | [multi-hub.md](multi-hub.md) | ✓ | この機能自体が Hub 連携の入口 |
| Legatus → Memoria GPS 転送 | [legatus-subscriber.md](legatus-subscriber.md) | 🏠 | loopback / tailnet 内で完結 |
| 外部 chat 取り込み | [external-chat.md](external-chat.md) | 🏠 | チャネル名 / 個人発言を含む |
| クレバーサーチ | [clever-search.md](clever-search.md) | 🏠 | 個人ログを横断検索し、レポートもローカル DB にのみ保存 |
| MCP server autostart | [mcp-server.md](mcp-server.md) | 🏠 | Claude Desktop / Code 連携 (ローカル stdio) |
| サーバ稼働 / heartbeat | [uptime.md](uptime.md) | 🏠 | PC 起動時間ログ |
| LLM プロバイダ設定 | [llm-config.md](llm-config.md) | 🏠 | OpenAI API key 等を含む |
| LLM 観測所 | [llm-observatory.md](llm-observatory.md) | 🏠 | native JSONL から利用量を派生集計。本文とローカル endpoint は保存しない |
| プライバシー設定 | [privacy-settings.md](privacy-settings.md) | 🏠 | feature flag 集中管理 |
| ストップワード | [stopwords.md](stopwords.md) | 🏠 | wordcloud 除外語 |
| ノート (WYSIWYG) | [note.md](note.md) | 🏠 | esa / DocBase 風ブロックベースエディタ。 markdown + 文字色 + テーブル + Mermaid |
| Chrome 拡張 dispatch | [extension.md](extension.md) | 🏠 | chat / impl / shopping ドメインで追加ボタンを出し分け |
| Hub 社会層 (コメント / いいね) | [hub-social.md](hub-social.md) | ✓ | subject 単位でコメント・いいね・フィード・通知。 記事本文への範囲コメント + **AIノート (`ai_articles`) の共有** 込み |
| AI ハブ (AIノート / ネタ / 助言) | [ai-hub.md](ai-hub.md) | ✓ / 🏠 | AI記事 (= AIノート) は Hub 共有可 (禁止語スキャン必須)。 記事ネタ / AIアドバイスは local-only |
| 実績共有 (achievements) | [hub-achievements.md](hub-achievements.md) | ✓ | GitHub / ローカル git / activity から「やった事」 を取り込み。 **既定は非共有**、 repo 単位 opt-in + 禁止語スキャン |
| 共同 dig (dig room) | [hub-dig-rooms.md](hub-dig-rooms.md) | ✓ | みんなでディグる。 append-only の contribution + rev 付きまとめ |
| Hub 同期 + ローカル Cernere 認証 | [hub-sync.md](hub-sync.md) | ✓ | 端末を 1 度登録 → 自動ログイン → 差分同期。 表示ソース選択。 **push は常に手動 + 先を選ぶ** |

## 凡例 (項目)
各 feature ファイルは以下のセクションを順序固定で持つ:

1. **概要** — 機能を 1-2 文で
2. **ユースケース** — どんな場面で使うか
3. **画面 / 入口** — UI 上どこから入るか
4. **データ** — 主要 SQLite テーブル + 物理ファイル
5. **API** — 関連 endpoint
6. **シェア可能か** — Hub-shareable / local-only / derived-only + 共有フィールドの具体
7. **プライバシー観点** — 個人データ / LLM 送信範囲 / 削除時の挙動

## 参考
- 個人データ保管禁止ルール (LUDIARS 全体): 個人データは Cernere が単一ソース。 Memoria は **個人ローカルツール** として例外的に大量保持するが、 Hub に出すのは明示的 share 操作分のみ
- Memoria online (Hub) は **read-public + write-relay-only** (PR #17、 Imperativus 経由)
- センシティブ情報 (GPS / 長期 WS / MQTT) は Tailscale 経由が推奨
