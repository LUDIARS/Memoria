# `spec/db/` — SQLite データモデル

Memoria ローカルサーバ (`server/db.ts` で初期化される SQLite ファイル) の
テーブル仕様書。 ファイルは原則 **1 ドメイン 1 ファイル** (関連テーブルをまとめる)。

## テーブル一覧 (ドメイン別)

| ドメイン | spec | 関連テーブル |
|---|---|---|
| ブックマーク | [bookmark.md](bookmark.md) | `bookmarks` / `bookmark_categories` / `accesses` |
| 辞書 | [dictionary.md](dictionary.md) | `dictionary_entries` / `dictionary_links` |
| Dig (deep research) | [dig.md](dig.md) | `dig_sessions` / `recommendation_dismissals` |
| ページ訪問 | [visit.md](visit.md) | `page_visits` / `visit_events` |
| ページメタ / ドメイン辞書 | [page.md](page.md) | `page_metadata` / `domain_catalog` |
| 日記 | [diary.md](diary.md) | `diary_entries` / `weekly_reports` / `diary_settings` |
| 活動ログ | [activity.md](activity.md) | `activity_events` / `server_events` |
| GPS | [gps.md](gps.md) | `gps_locations` |
| 食事 | [meal.md](meal.md) | `meals` |
| タスク | [task.md](task.md) | `tasks` |
| 実装自慢 | [impl.md](impl.md) | `implementation_notes` |
| 作業場所 | [workplace.md](workplace.md) | `work_locations` |
| AI 委託 | [agent.md](agent.md) | `agent_projects` / `agent_runs` |
| 外部チャット | [chat.md](chat.md) | `external_chat_messages` |
| 設定 | [settings.md](settings.md) | `app_settings` |
| Web Push | [push.md](push.md) | `push_subscriptions` |
| ワードクラウド | [wordcloud.md](wordcloud.md) | `word_clouds` |
| ストップワード | [stopwords.md](stopwords.md) | `user_stopwords` |
| ノート | [note.md](note.md) | `notes` / `note_blocks` |
| クレバーサーチ | [clever-search.md](clever-search.md) | `clever_search_sources` / `clever_search_fts` / `clever_search_reports` |
| 実績 (achievements) | [hub-social.md](hub-social.md) §8 | `achievement_sources` / `achievement_entries` / `achievement_redaction_terms` |

## Hub (Postgres) 側のテーブル

`spec/data/` は原則ローカル SQLite の仕様書だが、 共有サーバ層のテーブルは
1 か所にまとまっている方が読めるので例外として同フォルダに置く。

| ドメイン | spec | 関連テーブル |
|---|---|---|
| 共有サーバ層 | [hub-social.md](hub-social.md) | `subjects` / `comments` / `reactions` / `bookmark_renditions` / `notifications` / `achievement_entries` / `achievement_digests` / `ai_articles` / `dig_rooms` / `dig_contributions` / `dig_room_digests` / `dig_room_jobs` / `hub_members` |
| 同期 | [hub-sync.md](hub-sync.md) | Hub: `hub_changes` / ローカル: `hub_servers` / `hub_sync_state` / `hub_pushes` + 共有各表への `source_hub_id` |

Hub の既存 7 型テーブル (`bookmarks` / `dig_sessions` / `dictionary_entries` /
`implementation_notes` / `work_locations` / `domain_catalog` / `notes`) は
`server/multi/migrations/00*.sql` が正本 ([feature/multi-hub.md](../feature/multi-hub.md))。

## 表記

- 各列の Nullable は SQLite の `NOT NULL` 制約有無を反映
- `DEFAULT (datetime('now'))` の列は **UTC ISO** で保存される (ブラウザ側で
  `parseUtcIso` を経由してローカル時刻に変換)
- `*_json` 列は **JSON 文字列** を格納 (TS 側は `string` 型 + parse 関数を別途用意)
- `INTEGER NOT NULL DEFAULT 0` で論理値を表す列は TS では `0 | 1` (boolean に
  寄せたい場合は accessor 関数で正規化)
