// Dictionary + user stopwords router (mounted at `/api`).
//
// Both share the same router because they're tightly coupled UX-wise (stopword
// management lives next to dictionary editing) and we want fewer mount points.
import { Hono } from 'hono';

const VALID_DICT_SOURCE_KINDS = new Set(['cloud', 'dig', 'bookmark']);

export function createDictionaryRouter({
  db,
  listDictionaryEntries,
  getDictionaryEntry,
  findDictionaryEntryByTerm,
  insertDictionaryEntry,
  updateDictionaryEntry,
  deleteDictionaryEntry,
  addDictionaryLink,
  removeDictionaryLink,
  listUserStopwords,
  addUserStopword,
  removeUserStopword,
}) {
  const router = new Hono();

  // ---- dictionary --------------------------------------------------------

  router.get('/dictionary', (c) => {
    const search = c.req.query('q')?.trim() || undefined;
    return c.json({ items: listDictionaryEntries(db, { search }) });
  });

  router.get('/dictionary/:id', (c) => {
    const id = Number(c.req.param('id'));
    const e = getDictionaryEntry(db, id);
    if (!e) return c.json({ error: 'not found' }, 404);
    return c.json(e);
  });

  // ---- user stopwords (グラフ / ワードクラウド除外語) -------------------
  router.get('/stopwords', (c) => {
    return c.json({ items: listUserStopwords(db) });
  });
  router.post('/stopwords', async (c) => {
    const body = await c.req.json().catch(() => null);
    const word = (body?.word ?? '').toString().trim();
    if (!word) return c.json({ error: 'word required' }, 400);
    addUserStopword(db, word);
    return c.json({ ok: true, word });
  });
  router.delete('/stopwords/:word', (c) => {
    const word = decodeURIComponent(c.req.param('word'));
    const removed = removeUserStopword(db, word);
    return c.json({ ok: removed });
  });

  router.post('/dictionary', async (c) => {
    const body = await c.req.json().catch(() => null);
    const term = (body?.term ?? '').toString().trim();
    if (!term) return c.json({ error: 'term required' }, 400);
    const existing = findDictionaryEntryByTerm(db, term);
    if (existing) {
      // Idempotent: update if any new fields supplied, otherwise return existing.
      const patch = {};
      if (typeof body.definition === 'string') patch.definition = body.definition;
      if (typeof body.notes === 'string') patch.notes = body.notes;
      if (Object.keys(patch).length > 0) updateDictionaryEntry(db, existing.id, patch);
      return c.json({ id: existing.id, existed: true });
    }
    const id = insertDictionaryEntry(db, {
      term,
      definition: body.definition ?? null,
      notes: body.notes ?? null,
    });
    return c.json({ id, existed: false });
  });

  router.patch('/dictionary/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!getDictionaryEntry(db, id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    updateDictionaryEntry(db, id, body);
    return c.json(getDictionaryEntry(db, id));
  });

  router.delete('/dictionary/:id', (c) => {
    const id = Number(c.req.param('id'));
    deleteDictionaryEntry(db, id);
    return c.json({ ok: true });
  });

  router.post('/dictionary/:id/links', async (c) => {
    const id = Number(c.req.param('id'));
    if (!getDictionaryEntry(db, id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => null);
    const sourceKind = body?.source_kind;
    const sourceId = Number(body?.source_id);
    if (!VALID_DICT_SOURCE_KINDS.has(sourceKind)) return c.json({ error: 'source_kind must be cloud|dig|bookmark' }, 400);
    if (!Number.isFinite(sourceId)) return c.json({ error: 'source_id required' }, 400);
    addDictionaryLink(db, { entryId: id, sourceKind, sourceId });
    return c.json({ ok: true });
  });

  router.delete('/dictionary/:id/links', async (c) => {
    const id = Number(c.req.param('id'));
    const sourceKind = c.req.query('source_kind');
    const sourceId = Number(c.req.query('source_id'));
    if (!VALID_DICT_SOURCE_KINDS.has(sourceKind)) return c.json({ error: 'source_kind required' }, 400);
    if (!Number.isFinite(sourceId)) return c.json({ error: 'source_id required' }, 400);
    removeDictionaryLink(db, { entryId: id, sourceKind, sourceId });
    return c.json({ ok: true });
  });

  /** Convenience: upsert a term + add a source link in one call. */
  router.post('/dictionary/upsert-from-source', async (c) => {
    const body = await c.req.json().catch(() => null);
    const term = (body?.term ?? '').toString().trim();
    const sourceKind = body?.source_kind;
    const sourceId = Number(body?.source_id);
    if (!term) return c.json({ error: 'term required' }, 400);
    if (!VALID_DICT_SOURCE_KINDS.has(sourceKind)) return c.json({ error: 'source_kind required' }, 400);
    if (!Number.isFinite(sourceId)) return c.json({ error: 'source_id required' }, 400);

    const existing = findDictionaryEntryByTerm(db, term);
    let entryId;
    let existed = false;
    if (existing) {
      entryId = existing.id;
      existed = true;
      if (typeof body.definition === 'string' || typeof body.notes === 'string') {
        updateDictionaryEntry(db, entryId, {
          definition: typeof body.definition === 'string' ? body.definition : undefined,
          notes: typeof body.notes === 'string' ? body.notes : undefined,
        });
      }
    } else {
      entryId = insertDictionaryEntry(db, {
        term,
        definition: body.definition ?? null,
        notes: body.notes ?? null,
      });
    }
    addDictionaryLink(db, { entryId, sourceKind, sourceId });
    return c.json({ id: entryId, existed });
  });

  return router;
}
