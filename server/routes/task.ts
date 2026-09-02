// /api/tasks*, /api/tasks/categories*, /api/external-chat/messages*
// Spec: spec/interface/task.md

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  listTasks, listTaskCategories, registerTaskCategory, unregisterTaskCategory,
  getTask, updateTask, deleteTask,
  insertExternalChatMessage, listExternalChatMessages,
  listRepoWatch,
} from '../db.js';
import { privacySettings } from '../lib/privacy.js';
import { postTaskToDiscord } from '../discord/index.js';
import { registerTask } from '../shared/task-registration.js';
import { updateTaskWithJournal } from '../shared/task-mutation.js';

type Db = BetterSqlite3.Database;

export interface TaskRouterDeps {
  db: Db;
}

export function makeTaskRouter(deps: TaskRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  async function shareTaskToActio(task: {
    id: number;
    title: string;
    details?: string | null;
    status: string;
    kind: 'task' | 'goal';
    category?: string | null;
    creator_type: 'human' | 'ai';
    due_at?: string | null;
  }) {
    const settings = privacySettings(db);
    if (!settings.tasks_actio_share_enabled) throw new Error('Actio task sharing is disabled');
    if (!settings.actio_share_url) throw new Error('actio_share_url is not configured');
    const res = await fetch(settings.actio_share_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'memoria',
        external_id: `memoria-task-${task.id}`,
        title: task.title,
        details: task.details ?? '',
        status: task.status,
        kind: task.kind,
        category: task.category ?? null,
        creator_type: task.creator_type,
        due_at: task.due_at ?? null,
      }),
    });
    if (!res.ok) throw new Error(`Actio ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json().catch(() => ({}));
  }

  r.get('/api/tasks', (c: Context) => {
    const limit = Math.min(Number(c.req.query('limit') || 100), 200);
    const offset = Math.max(0, Number(c.req.query('offset') || 0));
    const statusQ = c.req.query('status');
    const validStatuses = ['todo', 'doing', 'done'] as const;
    const status = statusQ && (validStatuses as readonly string[]).includes(statusQ)
      ? statusQ as typeof validStatuses[number]
      : null;
    // kind: 'task' (default) | 'goal' | 'all'。 互換性のため未指定なら通常タスクのみ。
    const kindQ = c.req.query('kind');
    const validKinds = ['task', 'goal', 'all'] as const;
    const kind = kindQ && (validKinds as readonly string[]).includes(kindQ)
      ? kindQ as typeof validKinds[number]
      : null;
    return c.json({ items: listTasks(db, { status, kind, limit, offset }) });
  });

  r.get('/api/tasks/categories', (c: Context) => {
    const items = listTaskCategories(db);
    // サジェスト用に登録済リポを `owner/name` 形式で返す。 登録済カテゴリと
    // 被ったものは items 側にも残り、 datalist 側で union 表示すれば良い。
    const repos = listRepoWatch(db).map((r) => `${r.owner}/${r.name}`);
    return c.json({ items, suggestions: { repos } });
  });

  r.post('/api/tasks/categories', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { name?: unknown };
    const name = String(body.name ?? '').trim();
    if (!name) return c.json({ error: 'name required' }, 400);
    registerTaskCategory(db, name);
    return c.json({ items: listTaskCategories(db) }, 201);
  });

  r.delete('/api/tasks/categories/:name', (c: Context) => {
    const name = decodeURIComponent(c.req.param('name') ?? '');
    unregisterTaskCategory(db, name);
    return c.json({ items: listTaskCategories(db) });
  });

  r.post('/api/tasks', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as
      { title?: unknown; details?: unknown; status?: unknown; kind?: unknown; creator_type?: unknown;
        due_at?: unknown; share_actio?: unknown; category?: unknown; _skip_discord_notify?: unknown };
    const title = String(body.title ?? '').trim();
    if (!title) return c.json({ error: 'title required' }, 400);
    const status: 'todo' | 'doing' | 'done' = (['todo', 'doing', 'done'] as const).includes(body.status as 'todo' | 'doing' | 'done')
      ? body.status as 'todo' | 'doing' | 'done'
      : 'todo';
    const kind: 'task' | 'goal' = body.kind === 'goal' ? 'goal' : 'task';
    const created = registerTask(db, {
      title,
      details: String(body.details ?? '').trim(),
      status,
      kind,
      creator_type: body.creator_type === 'ai' ? 'ai' : 'human',
      due_at: typeof body.due_at === 'string' ? body.due_at : null,
      share_actio: !!body.share_actio,
      category: typeof body.category === 'string' ? body.category.trim() : null,
    });
    if (!body._skip_discord_notify) {
      void postTaskToDiscord(db, created).catch(() => {});
    }
    return c.json({ task: created }, 201);
  });

  r.patch('/api/tasks/:id', async (c: Context) => {
    const id = Number(c.req.param('id'));
    const before = getTask(db, id);
    if (!before) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as
      { title?: unknown; details?: unknown; status?: unknown; kind?: unknown; due_at?: unknown;
        share_actio?: unknown; category?: unknown };
    const patch: Record<string, unknown> = {};
    if (typeof body.title === 'string') patch.title = body.title.trim();
    if (typeof body.details === 'string') patch.details = body.details.trim();
    if ((['todo', 'doing', 'done'] as const).includes(body.status as 'todo' | 'doing' | 'done')) patch.status = body.status;
    if (body.kind === 'task' || body.kind === 'goal') patch.kind = body.kind;
    if (body.due_at === null || typeof body.due_at === 'string') patch.due_at = body.due_at || null;
    if (typeof body.share_actio === 'boolean') patch.share_actio = body.share_actio;
    if (typeof body.category === 'string' || body.category === null) patch.category = body.category;
    const result = updateTaskWithJournal(db, id, patch);
    if (!result) return c.json({ error: 'task disappeared' }, 500);
    return c.json({ task: result.after });
  });

  r.delete('/api/tasks/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!getTask(db, id)) return c.json({ error: 'not found' }, 404);
    deleteTask(db, id);
    return c.json({ ok: true });
  });

  r.post('/api/tasks/:id/share/actio', async (c: Context) => {
    const id = Number(c.req.param('id'));
    const task = getTask(db, id);
    if (!task) return c.json({ error: 'not found' }, 404);
    try {
      const result = await shareTaskToActio(task);
      updateTask(db, id, {
        share_actio: 1,
        shared_at: new Date().toISOString(),
        shared_origin: privacySettings(db).actio_share_url || 'actio',
      });
      return c.json({ ok: true, result, task: getTask(db, id) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 502);
    }
  });

  r.post('/api/external-chat/messages', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as
      { source?: unknown; conversation_id?: unknown; role?: unknown; content?: unknown; metadata?: unknown };
    const source = String(body.source ?? '').trim() || 'unknown';
    const content = String(body.content ?? '').trim();
    if (!content) return c.json({ error: 'content required' }, 400);
    const id = insertExternalChatMessage(db, {
      source,
      conversation_id: typeof body.conversation_id === 'string' ? body.conversation_id : null,
      role: typeof body.role === 'string' ? body.role : null,
      content,
      metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata as Record<string, unknown> : null,
    });
    return c.json({ id }, 201);
  });

  r.get('/api/external-chat/messages', (c: Context) => {
    const limit = Math.min(Number(c.req.query('limit') || 100), 200);
    const offset = Math.max(0, Number(c.req.query('offset') || 0));
    const source = c.req.query('source') ?? null;
    return c.json({ items: listExternalChatMessages(db, { source, limit, offset }) });
  });

  return r;
}
