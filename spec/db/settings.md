# settings — 汎用 key/value 永続化

## `app_settings`
LLM 設定、 機能フラグ、 連携 URL、 マイグレーション補助フラグなど、
一般的な key/value をすべてここに置く。

| 列 | 型 | NotNull | 役割 |
|---|---|---|---|
| `key` | TEXT | ✓ | PK。 namespace.subkey 形式 (`features.tracks.enabled` 等) |
| `value` | TEXT |  | 文字列のみ。 number / boolean は呼び出し側で parse |

## キー命名規約

| Prefix | 用途 |
|---|---|
| `features.<sub>.*` | 機能 ON/OFF 系 (`features.tasks.reminder.enabled`, `features.workplace.geo.enabled`) |
| `llm.*` | LLM プロバイダ + モデル |
| `task.categories.registered` | カテゴリプリセット (JSON 配列) |
| `tasks.reminder.last_sent_date` | リマインダー日次ガード |
| `actio.share_url` | Actio タスク共有 URL |
| `multi_servers` / `multi_active_urls` | Hub 接続管理 (JSON) |
| `places.api.url` / `places.api.ua` | Place API 設定 |
| `runtime.git_bash_path` | Windows + claude CLI 用 |
| `tracks.decimate_meters` / `tracks.show_polyline` | 軌跡描画設定 |
| `workplace.current.id` / `workplace.current.at` | サイレントチェックイン状態 |
| `places.api.url` / `places.api.ua` | Place API カスタム設定 |
