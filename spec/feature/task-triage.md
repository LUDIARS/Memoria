# 期限未設定タスクの棚卸しセッション (task-triage)

## 概要

期限 (`due_at`) が設定されていない未完タスクを、 **セッション形式** で人が 1 件ずつ捌くための機能。
朝の自動棚卸し ([task-review](task-review.md)) は **期限超過のみ** を対象にするため、 期限のない山
(2026-09 時点で約 400 件) はここで手動 + AI 提案で片付ける。

- セッションを開始すると、 その時点の「期限なし・未完」タスク id を固定して積む (提示順: カテゴリ → 作成日昇順)。
- 10 件ずつ提示し、 1 件ごとに次の 4 択で判断する:
  - **期限を置く (due)** — 日付を入れてタスクの `due_at` に書く
  - **完了 (done)** — `status='done'` にする
  - **期限なしのまま (keep)** — タスクは触らず「棚卸し済み」として扱う (いつかやる / 参考メモ / 方針)
  - **あとで (later)** — いまは判断せず後回し。 未判断が尽きたら末尾で再提示される
- 途中でブラウザを閉じても、 次に開いたとき active なセッションを **再開** する (判断は都度 DB に書く)。
- 「AI 提案」で提示中バッチに Sonnet の提案 (due / done / keep + 理由) を付ける。 提案は入力欄を埋めるだけで、 **適用は必ず人のクリック**。
- 「セッション終了」でいつでも閉じられる。 残りは次のセッションでまた集め直す。

> task-review と同じく Concordia / Delegation は使わない。 Memoria 内 (DB + LLM + UI) で完結する。

## データ (server/task-triage/schema.ts)

```sql
CREATE TABLE IF NOT EXISTS task_triage_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL DEFAULT 'undated' CHECK (scope = 'undated'),
  task_ids    TEXT NOT NULL,                      -- JSON number[]: 開始時の対象 (提示順)
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS task_triage_decisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL,
  task_id     INTEGER NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('due', 'done', 'keep', 'later')),
  due_at      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(session_id, task_id),
  FOREIGN KEY(session_id) REFERENCES task_triage_sessions(id) ON DELETE CASCADE
);
```

- `ensureTaskTriageSchema(db)` を `openDb` (db.ts) から呼ぶ (boot 時冪等)。
- partial unique index により active なセッションは常に高々 1 件。schema 初期化時に複数 active が残っていれば最新以外を finished に直してから index を作る。`POST /session` は active があればそれを返し (再開)、 `restart: true` で finished にして集め直す。
- 判断は (session, task) で UNIQUE。 再判断は上書き (later → keep 等)。

## セッション (server/task-triage/session.ts)

- `orderUndatedTasks(tasks)`: `status != 'done' && due_at IS NULL` をカテゴリ (先頭値) → `created_at` 昇順に。 純関数。
- `pickBatch(session, decisions, current, size)`: 提示順に「判断なし」→「later」の順で、 **現時点でも未完かつ期限なし** のものだけを最大 size 件。 セッション外で完了/期限付与されたタスクは解決済みとして飛ばす。 純関数。
- `computeProgress(...)`: `total` / `decided` (最終判断済み + 外部解決) / `deferred` (later 中) / `remaining` / 判断種別ごとの `counts`。 純関数。
- `decideTask(db, sessionId, taskId, decision, dueAt)`: タスク本体へ反映 (due → 期限設定、 done → 完了) してから決定を upsert。更新は `server/shared/task-mutation.ts` を通し、通常のタスク API と同じく AI 作成タスクの期限変更を human 扱いにし、日記・活動ログも記録する。`due_at` は実在する `'YYYY-MM-DD'` (18:00 を補う) か `'YYYY-MM-DDTHH:MM'`。セッション外の id / finished セッション / 不正な暦日・時刻は拒否する。
- 表示後にタスクが完了または期限付きへ変わっていた場合は stale action として `409` にし、新しい状態を上書きしない。タスク更新・副作用・判断記録は 1 SQLite transaction で適用する。

## AI 提案 (server/task-triage/suggest.ts)

`LlmTaskName` に `task_triage` (既定 'sonnet') を追加。 提示中バッチ (最大 10 件) を渡し、 各タスクに 1 つの提案:

```json
{ "suggestions": [
  { "task_id": 12, "action": "due",  "due_in_days": 7, "reason": "PR 提出待ちで来週に片付く" },
  { "task_id": 15, "action": "keep", "reason": "参考メモで作業ではない" } ] }
```

- 未知 id / 不正 action / reason 無し / 重複 id は捨てる。 `due_in_days` は 1〜90 に丸め、 無ければ 7。 サーバ側で `due_at` (`'YYYY-MM-DDT18:00'` local) を起こして返す。
- 「迷ったら keep」と指示し、 過剰に期限を置かせない。

## API (server/task-triage/router.ts, mount `/api/task-triage`)

- `GET  /api/task-triage/session?batch=10` → `{ state: TaskTriageState | null, undated_total }` (active が無ければ null)
- `POST /api/task-triage/session` `{ restart?, batch? }` → `{ state }` (開始 / 再開 / 集め直し)
- `GET  /api/task-triage/sessions` → `{ items }` (履歴 20 件)
- `GET  /api/task-triage/session/:id` → `{ state }`
- `POST /api/task-triage/session/:id/decide` `{ task_id, decision, due_at?, batch? }` → `{ ok, state }`。 400 (不正) / 404 / 409 (finished または stale task)
- `POST /api/task-triage/session/:id/suggest` `{ batch? }` → `{ suggestions }` (適用しない)
- `POST /api/task-triage/session/:id/finish` → `{ ok, state }`

`TaskTriageState = { session, progress, batch: TaskRow[] }`。

全 route に `isSameMachineRequest` を適用する。個人タスク本文の読取・変更と LLM 起動は、同一端末から許可済み browser host を同一 origin で開いたリクエストに限る。グローバル CORS が有効でも cross-origin / remote client は `403`。
LLM provider/CLI の失敗内容はローカルパスや接続先本文を含み得るため、API には固定の公開エラーだけを返す。

## UI (server/public/src/task-triage-view.ts)

- 📝 タスクタブの「🔁 タスク確認」パネル直下に `#taskTriagePanel`。 `loadTasks()` から `loadTaskTriageView()` を呼ぶ。
- active が無いとき: 「📅 期限未設定の棚卸し — N 件が期限なし [セッション開始]」の 1 行。 0 件ならボタンなし。
- active があるとき: 進捗バー (`decided / total`、 残・後回し・種別カウント) + [AI 提案] [集め直す] [セッション終了] + バッチのカード。
- カード: `#id` / カテゴリ / 作成日 / status / タイトル / details 抜粋 / (あれば) AI 提案行 / `date` 入力 + [期限を置く] [完了] [期限なしのまま] [あとで]。 AI 提案が due のとき date 入力を先埋めする。
- 入力 UI は `.foundation-form` ([[feedback_memoria_foundation_input]])。
- 自己完結モジュール (task-review-view.ts と同形)。 app.ts の state/DOM 内部に依存しない。 due/done で board 再読込コールバックを呼ぶ。

## テスト

- `task-triage/session.test.ts` — in-memory SQLite で 開始/再開/restart、 各判断の反映、 later の再提示、 stale 更新の拒否、暦日検証、日記・活動ログ、 finish 後の拒否。
- `task-triage/suggest.test.ts` — LLM 出力の検証 (未知 id / 不正 action / 丸め / local 日付)。
- `task-triage/router.test.ts` — API 一連 (LLM は差し替え) と same-machine / same-origin 境界。

## シェア可能か / プライバシー
local-only。 タスクは個人データ。 LLM 送信は既存 `runLlm` の provider 設定に従う。 生成物はローカル SQLite に閉じる ([[project_personal_data_rule]])。
