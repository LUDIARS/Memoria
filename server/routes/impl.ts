// /api/implementation-notes* — 実装自慢ノート (本人 only / shareable で Hub 公開可)。
// Spec: spec/interface/impl.md

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  listImplementationNotes, getImplementationNote, insertImplementationNote,
  updateImplementationNote, deleteImplementationNote,
} from '../db.js';

type Db = BetterSqlite3.Database;

export interface ImplRouterDeps {
  db: Db;
}

export function makeImplRouter(deps: ImplRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  r.get('/api/implementation-notes', (c: Context) => {
    const limit = Math.min(Number(c.req.query('limit') || 100), 200);
    const offset = Math.max(0, Number(c.req.query('offset') || 0));
    const shareable = c.req.query('shareable');
    const items = listImplementationNotes(db, {
      limit,
      offset,
      shareable: shareable == null ? null : shareable === '1' || shareable === 'true',
    });
    return c.json({ items });
  });

  r.post('/api/implementation-notes', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as
      { product?: unknown; title?: unknown; good_points?: unknown; bad_points?: unknown;
        attachment_type?: unknown; attachment_value?: unknown; shareable?: unknown };
    const title = String(body.title ?? '').trim();
    if (!title) return c.json({ error: 'title required' }, 400);
    const attachmentType = String(body.attachment_type ?? '').trim();
    const attachmentValue = String(body.attachment_value ?? '').trim();
    const id = insertImplementationNote(db, {
      product: String(body.product ?? '').trim(),
      title,
      good_points: String(body.good_points ?? '').trim(),
      bad_points: String(body.bad_points ?? '').trim(),
      attachment_type: attachmentType || null,
      attachment_value: attachmentValue || null,
      shareable: !!body.shareable,
    });
    return c.json({ note: getImplementationNote(db, id) }, 201);
  });

  r.patch('/api/implementation-notes/:id', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!getImplementationNote(db, id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of ['product', 'title', 'good_points', 'bad_points', 'attachment_type', 'attachment_value']) {
      if (typeof body[k] === 'string') patch[k] = (body[k] as string).trim();
    }
    if (typeof body.shareable === 'boolean') patch.shareable = body.shareable;
    updateImplementationNote(db, id, patch);
    return c.json({ note: getImplementationNote(db, id) });
  });

  r.delete('/api/implementation-notes/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!getImplementationNote(db, id)) return c.json({ error: 'not found' }, 404);
    deleteImplementationNote(db, id);
    return c.json({ ok: true });
  });

  r.post('/api/implementation-notes/:id/share', async (c: Context) => {
    const id = Number(c.req.param('id'));
    const note = getImplementationNote(db, id);
    if (!note) return c.json({ error: 'not found' }, 404);
    if (!note.shareable) return c.json({ error: 'note is not marked shareable' }, 409);
    updateImplementationNote(db, id, { shared_at: new Date().toISOString(), shared_origin: 'local' });
    return c.json({ ok: true, note: getImplementationNote(db, id) });
  });

  return r;
}
