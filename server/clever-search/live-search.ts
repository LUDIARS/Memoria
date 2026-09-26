import type BetterSqlite3 from 'better-sqlite3';
import { listTasks } from '../tasks/store.js';
import { normalizeCleverSearchQuery, searchCleverDocuments } from './store.js';
import type { CleverSearchHit } from './types.js';

/** New reports use current Actio content; saved reports remain historical snapshots. */
export async function searchLiveDocuments(db: BetterSqlite3.Database, query: string): Promise<CleverSearchHit[]> {
  const local = searchCleverDocuments(db, query);
  if (process.env.MEMORIA_TASK_BACKEND === 'sqlite') return local;
  const terms = query.split(' ').filter(Boolean);
  const tasks = await listTasks(db, { kind: 'all', limit: Number.MAX_SAFE_INTEGER });
  const remote: CleverSearchHit[] = [];
  for (const task of tasks) {
    const content = [task.details, task.category, task.status, task.creator_type].filter(Boolean).join(' ');
    const title = normalizeCleverSearchQuery(task.title);
    const normalizedContent = normalizeCleverSearchQuery(content);
    if (!terms.length || !terms.every(term => title.includes(term) || normalizedContent.includes(term))) continue;
    remote.push({
      id: -task.id, source_type: 'task', source_id: String(task.id), report_category: 'action',
      title: task.title, content, occurred_at: task.updated_at ?? task.created_at,
      source_subtype: task.kind, score: 0,
    });
  }
  return [...local.filter(hit => hit.source_type !== 'task'), ...remote];
}
