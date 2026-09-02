// task-triage — テーブル定義 (boot 時冪等)。 db.ts の openDb から呼ぶ。
// Spec: spec/feature/task-triage.md §データ

import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export function ensureTaskTriageSchema(db: Db): void {
  db.exec(`
    -- 期限未設定タスクの棚卸しセッション。 開始時に対象 id を固定し、 判断を積んでいく。
    CREATE TABLE IF NOT EXISTS task_triage_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      scope       TEXT NOT NULL DEFAULT 'undated' CHECK (scope = 'undated'),
      task_ids    TEXT NOT NULL,                      -- JSON number[]: 開始時の対象 (提示順)
      status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_triage_sessions_status
      ON task_triage_sessions(status, created_at DESC);
    -- 旧ビルド等で複数 active が残っていても boot を失敗させず、最新だけを再開対象にする。
    UPDATE task_triage_sessions
       SET status = 'finished',
           finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     WHERE status = 'active'
       AND id <> (
         SELECT id FROM task_triage_sessions
          WHERE status = 'active'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_triage_single_active
      ON task_triage_sessions(status) WHERE status = 'active';

    -- セッション内の判断 (1 タスク 1 行、 再判断は上書き)。
    CREATE TABLE IF NOT EXISTS task_triage_decisions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL,
      task_id     INTEGER NOT NULL,
      decision    TEXT NOT NULL CHECK (decision IN ('due', 'done', 'keep', 'later')),
      due_at      TEXT,                               -- decision='due' のときの期限
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(session_id, task_id),
      FOREIGN KEY(session_id) REFERENCES task_triage_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_triage_decisions_session
      ON task_triage_decisions(session_id, decision);
  `);
}
