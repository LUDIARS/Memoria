// /api/diary/:date/sections* — 日記の外部節。
// Spec: spec/interface/diary.md

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { isSameMachineRequest } from '../lib/local-request.js';
import {
  DIARY_DATE_RE, SECTION_SOURCE_RE,
  ensureDiarySectionsSchema, validateDiarySectionInput,
  getDiarySection, listDiarySections, putDiarySection, deleteDiarySection,
} from './sections-store.js';

/** Writes come from same-machine callers (Concordia over loopback, or this machine's UI) only. */
export const localDiaryWrite: MiddlewareHandler = async (c, next) => {
  const site = c.req.header('sec-fetch-site');
  if (!isSameMachineRequest(c) || (site && site !== 'same-origin' && site !== 'none'))
    return c.json({ error: 'local_only' }, 403);
  await next();
};

export function makeDiarySectionsRouter(db: BetterSqlite3.Database): Hono {
  ensureDiarySectionsSchema(db);
  const r = new Hono();

  const params = (c: Context) => ({ date: c.req.param('date') ?? '', source: c.req.param('source') ?? '' });
  const invalid = (date: string, source?: string): string | null =>
    !DIARY_DATE_RE.test(date) ? 'invalid date'
      : source !== undefined && !SECTION_SOURCE_RE.test(source) ? 'invalid source' : null;

  r.get('/api/diary/:date/sections', (c: Context) => {
    const { date } = params(c);
    const error = invalid(date);
    if (error) return c.json({ error }, 400);
    return c.json({ date, items: listDiarySections(db, date) });
  });

  r.get('/api/diary/:date/sections/:source', (c: Context) => {
    const { date, source } = params(c);
    const error = invalid(date, source);
    if (error) return c.json({ error }, 400);
    const section = getDiarySection(db, date, source);
    return section ? c.json(section) : c.json({ error: 'not found' }, 404);
  });

  r.put('/api/diary/:date/sections/:source', localDiaryWrite, async (c: Context) => {
    const { date, source } = params(c);
    const body = await c.req.json().catch(() => null);
    const input = validateDiarySectionInput(date, source, body);
    if (!input.ok) return c.json({ error: input.error }, 400);
    return c.json(putDiarySection(db, date, source, input));
  });

  r.delete('/api/diary/:date/sections/:source', localDiaryWrite, (c: Context) => {
    const { date, source } = params(c);
    const error = invalid(date, source);
    if (error) return c.json({ error }, 400);
    return deleteDiarySection(db, date, source) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  return r;
}
