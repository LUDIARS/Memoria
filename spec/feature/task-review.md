# タスク確認 (朝の Sonnet タスク棚卸し)

## 概要

毎朝、Memoria 内で Sonnet を起動して当日のタスクを棚卸しし、人間に「確認」を促すキューを積む。
2 種類の提案を出す:

1. **クラスタ (cluster)** — 同じプロジェクト (category) 内の **近い / 重複しているタスク** を 1 グループにまとめ、代表 1 件への統合を提案する。
2. **完了確認 (completed)** — details や文脈から **既に完了していそうなタスク** を検出し、クローズを提案する。

結果は `task_reviews` テーブルに `pending` で積まれ、Web UI の「タスク確認」キューに並ぶ。ユーザが [適用] / [却下] を選ぶ。

> Concordia / Delegation は使わない。完全に Memoria 内 (scheduler + LLM + DB + UI) で完結する。
> 朝タスクの「実装系を AI が自走する」フロー (Concordia MorningScheduler) とは別物で、これは **人間が確認するための整理キュー** に限定する。

## トリガー

- **朝スケジューラ**: `server/task-review/scheduler.ts`。既存 ai-hub scheduler と同形 (毎分 tick、設定時刻に当日 1 回、`app_settings` の `last_date` ガード、try/catch で全体を止めない)。
- **手動**: `POST /api/task-reviews/run-now` (ユーザが任意のタイミングで再解析できる)。

### app_settings キー
- `task_review.enabled` 既定 '1'
- `task_review.time` 既定 '08:00'
- `task_review.last_date` (実行済みフラグ)

## データ (server/db.ts)

```sql
CREATE TABLE IF NOT EXISTS task_reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,                  -- 'cluster' | 'completed'
  project     TEXT,                           -- 所属プロジェクト(category)。cluster 用、completed は null 可
  task_ids    TEXT NOT NULL,                  -- JSON number[]: 対象タスク id
  primary_id  INTEGER,                        -- cluster: 統合先 (代表) タスク id
  reason      TEXT NOT NULL,                  -- 提案理由 (人間向け短文)
  snapshot    TEXT NOT NULL,                  -- JSON [{id,title,status}]: 生成時スナップショット (存在/変更検知用)
  status      TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'applied' | 'dismissed'
  for_date    TEXT,                           -- 生成対象日 YYYY-MM-DD
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  applied_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_reviews_status ON task_reviews(status, created_at DESC);
```

- 既存 CREATE TABLE と同じ exec ブロックに置く (boot 時冪等)。CREATE INDEX は CREATE TABLE の後 ([[feedback_sqlite_create_index_after_alter]])。
- 解析を回すたびに **既存 pending を全削除してから** 新規 insert する (毎朝の棚卸しは「その時点のスナップショット」なので、古い pending を残さない)。`applied` / `dismissed` は履歴として残す。

## LLM タスク (server/llm.ts)

`LlmTaskName` / `TASKS` / `TASK_DEFAULT_MODELS` に追加:
- `task_review` (既定 'sonnet') — todo/doing タスク一覧から「同一プロジェクトの近いタスクのクラスタ」と「完了していそうなタスク」を JSON で抽出する。短中文。

入力はプロジェクト (category) ごとにグルーピングしたタスク一覧 (id / title / details 抜粋 / status / due)。出力 JSON:

```json
{
  "clusters": [
    { "project": "Anatomia", "task_ids": [322, 364], "primary_id": 322, "reason": "同じ動的トレース検証の残作業で重複" }
  ],
  "completed": [
    { "task_id": 299, "reason": "details に『マージ済』とあり再起動だけ未反映で実質完了" }
  ]
}
```

- LLM 出力 id は実在タスク集合で必ず検証し、未知 id は捨てる。`primary_id` が cluster の `task_ids` に含まれない場合は先頭を代表にフォールバック。
- 過剰グルーピング防止: 「明確に重複/近接するものだけ。少しでも別作業なら分けよ」と指示し、迷ったらクラスタにしない。

## API (server/routes/task-review.ts, mount `/api/task-reviews`)

- `GET  /api/task-reviews?status=pending` → `{ items: TaskReview[] }` (既定 pending、`all` で全件)
- `POST /api/task-reviews/run-now` → 即時に Sonnet 解析を実行し pending を作り直す → `{ created, items }`
- `POST /api/task-reviews/:id/apply` → 提案を適用する。**実行直前に対象タスクの存在 + (title,status) をスナップショットと突き合わせ**、消えている / 変更されていたら `409 { error, conflicts }` でブロック (朝の解析後にタスク修正が入っても安全)。
  - **cluster**: `primary_id` を統合先に残し、それ以外の task_ids を `status='done'` にクローズ。代表タスクの details 末尾に「統合: #id タイトル」を追記。
  - **completed**: 対象タスクを `status='done'` にする。
  - 成功で review.status='applied' + applied_at。
- `POST /api/task-reviews/:id/dismiss` → review.status='dismissed' → `{ ok: true }`

### 存在確認 (圧縮前ガード)
`detectSnapshotConflicts(snapshot, currentTasks)` を純関数で持ち、apply の最初に必ず通す。
- 対象 id が現存しない → conflict (kind: 'missing')
- title / status が snapshot と不一致 → conflict (kind: 'changed')
conflict があれば一切変更せず 409。ユーザは UI で「再解析」して作り直す。

## UI (server/public/src/task-review-view.ts)

- 📝 タスクタブの上部に「🔁 タスク確認」パネル (`#taskReviewPanel`)。`loadTasks()` から `loadTaskReviewView()` を呼んで board と一緒に更新する。
- pending が 0 件ならパネルは控えめな空表示 + 「いま棚卸し」ボタン (run-now)。
- 各 review カード: 種別バッジ (まとめる / 完了確認) + 対象タスク `#id タイトル` 一覧 + 理由 + [適用] / [却下]。
- 適用が 409 (conflict) のときはトーストで「タスクが変更されたため再解析してください」と出し、run-now を促す。
- 自己完結モジュール (ai-view.ts と同形)。app.ts の state/DOM 内部に依存しない。

## シェア可能か / プライバシー
local-only。タスクは個人データ。LLM 送信は既存 `runLlm` の provider 設定に従う (ローカル provider 選択でローカル完結可)。生成物はローカル SQLite に閉じる ([[project_personal_data_rule]])。
