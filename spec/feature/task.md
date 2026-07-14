# task — タスク管理

## 概要
TODO + カテゴリ + AI 委託 (agent_runs リンク) を持つタスク管理。 完了 / 更新時は自動で日記の `notes` に時刻付きで記録され、 `activity_events` にも入る。 任意で Actio に共有可能。

## ユースケース
- 個人的な TODO 管理 (`todo` / `doing` / `done`)
- AI に「このタスク実装して」 と委託する起点 (`/api/tasks/:id/agent-run`)
- カテゴリで開発 / 学習 / 雑務などを分けて表示
- 期日付きタスク → 朝 6:00 にリマインダー push (`tasks_reminder_*` 設定)
- Actio (LUDIARS のスケジューラ) に共有 (`/api/tasks/:id/share/actio`)

## 画面 / 入口
- `🗄 データベース` タブ → サブビュー `タスク`
- 詳細モーダルから「AI に委託」 → agent project + agent + model 選択 → `agent_runs` を生成

## データ
- [tasks](../data/task.md) — title / details / status / creator_type (human/ai) / due_at / share_actio / category (カンマ区切り)
- カテゴリプリセット: `app_settings.task.categories.registered` (JSON 配列、 0 件カテゴリも保持)
- 連動: [agent_runs](../data/agent.md) (task_id 経由)、 [activity_events](../data/activity.md) (kind=task_created/task_done/task_updated)、 [diary_entries.notes](../data/diary.md) に時刻付き行追記

## API
- [task.md](../interface/task.md) — `/api/tasks*` (CRUD) / `/api/tasks/categories*` / `/api/tasks/:id/agent-run` (AI 起動) / `/api/tasks/:id/share/actio`

## シェア可能か
**Hub-shareable** (Actio 経由のみ)

シェア先は **Memoria Hub ではなく Actio** (LUDIARS スケジューラ)。 `actio.share_url` 設定 + `tasks_actio_share_enabled` フラグ ON のときのみ機能。

シェアされるフィールド (Actio に POST):

| field | 内容 |
|---|---|
| `source` | `'memoria'` |
| `external_id` | `memoria-task-{id}` |
| `title` | タスク名 |
| `details` | 詳細メモ |
| `status` | todo/doing/done |
| `due_at` | 期日 |

シェアされない:
- `category`, `creator_type`, `agent_runs` 紐付け、 `activity_events`

経路: `POST /api/tasks/:id/share/actio` → サーバから Actio の share_url に直 POST (Memoria Hub 経由ではない)。

## プライバシー観点
- **個人データを保持するテーブル**: `tasks` (個人 TODO)、 `activity_events` (task_* kind の行)。 詳細メモが個人情報になりうる。
- **LLM プロバイダに送る情報**: タスク機能自体は LLM を呼ばない。 `agent-run` で `agent_dispatch` 経由 (claude / codex / gemini CLI を spawn) でプロンプト + project rules を送るのは別機能 ([agent.md](agent.md))。
- **共有時に外部に出ない情報**: カテゴリ、 AI 委託履歴 (agent_runs)、 activity_events、 日記の追記行。
- **削除時の挙動**: `DELETE /api/tasks/:id` で `tasks` 行を削除。 関連 `activity_events` (task_* kind) と `agent_runs` (task_id) は **削除しない** (履歴として残す設計)。 Actio 側にシェア済の場合は Actio に残置。
