import test from 'node:test';
import assert from 'node:assert/strict';
import { insertTask, openDb, recordActivityEvent, upsertDiary } from '../db.js';
import { gatherPersonalityFeatureInputs } from './feature-inputs.js';

test('gatherPersonalityFeatureInputs uses local diary keys and excludes future records', () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  const db = openDb(':memory:');
  try {
    const now = new Date('2026-07-19T15:30:00.000Z'); // 2026-07-20 00:30 JST

    upsertDiary(db, { date: '2026-04-20', workMinutes: 60 });
    upsertDiary(db, { date: '2026-04-21', workMinutes: 90 });
    upsertDiary(db, { date: '2026-07-20', workMinutes: 120 });
    upsertDiary(db, { date: '2026-07-21', workMinutes: 150 });

    const pastTaskId = insertTask(db, { title: 'past task' });
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?')
      .run('2026-07-19T14:30:00.000Z', pastTaskId);
    const futureTaskId = insertTask(db, { title: 'future task' });
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?')
      .run('2026-07-19T16:30:00.000Z', futureTaskId);

    recordActivityEvent(db, {
      kind: 'git_commit',
      occurred_at: '2026-07-19T14:30:00.000Z',
      ref_id: 'past',
    });
    recordActivityEvent(db, {
      kind: 'git_commit',
      occurred_at: '2026-07-19T16:30:00.000Z',
      ref_id: 'future',
    });

    const result = gatherPersonalityFeatureInputs(db, now);

    assert.deepEqual(result.diaries.map((diary) => diary.date), ['2026-04-21', '2026-07-20']);
    assert.deepEqual(result.tasks.map((task) => task.created_at), ['2026-07-19T14:30:00.000Z']);
    assert.deepEqual(result.activities.map((activity) => activity.occurred_at), ['2026-07-19T14:30:00.000Z']);
  } finally {
    db.close();
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
