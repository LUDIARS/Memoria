import type BetterSqlite3 from 'better-sqlite3';
import { getTask } from '../db.js';
import type { TaskRow } from '../db/types/task.js';
import { registerTask } from '../shared/task-registration.js';
import {
  findProcessedAlexaTaskId,
  rememberProcessedAlexaTask,
} from './store.js';

type Db = BetterSqlite3.Database;

export interface AlexaTaskRegistrationResult {
  task: TaskRow;
  created: boolean;
}

export function registerAlexaTask(
  db: Db,
  input: { requestId: string; title: string },
  now: Date = new Date(),
): AlexaTaskRegistrationResult {
  const transaction = db.transaction((): AlexaTaskRegistrationResult => {
    const existingTaskId = findProcessedAlexaTaskId(db, input.requestId);
    if (existingTaskId !== null) {
      const existing = getTask(db, existingTaskId);
      if (existing) return { task: existing, created: false };
    }

    const task = registerTask(db, {
      title: input.title,
      details: '',
      status: 'todo',
      kind: 'task',
      creator_type: 'human',
      due_at: null,
      category: null,
    }, now);
    rememberProcessedAlexaTask(db, input.requestId, task.id, now);
    return { task, created: true };
  });
  return transaction();
}
