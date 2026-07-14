import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { registerAlexaTask } from './task-registration.js';

test('同じAlexa requestIdの再送でタスクを重複登録しない', () => {
  const db = openDb(':memory:');
  try {
    const now = new Date('2026-07-10T10:00:00.000Z');
    const first = registerAlexaTask(db, { requestId: 'request-1', title: '牛乳を買う' }, now);
    const second = registerAlexaTask(db, { requestId: 'request-1', title: '牛乳を買う' }, now);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.task.id, first.task.id);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count, 1);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM activity_events WHERE kind = 'task_created'").get() as { count: number }).count,
      1,
    );
    const diary = db.prepare("SELECT notes FROM diary_entries WHERE date = '2026-07-10'").get() as { notes: string };
    assert.match(diary.notes, /牛乳を買う/);
  } finally {
    db.close();
  }
});
