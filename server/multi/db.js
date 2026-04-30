// Postgres adapter for the multi server.
//
// The multi server only ever serves the three shareable resource types
// (bookmarks / dictionary entries / dig sessions) plus a moderation log.
// No HTML body, no visit history, no diary — see migrations/001_init.sql
// and `docs/multi-server-architecture.md`.
import pg from 'pg';

const { Pool } = pg;

let pool = null;

export function openPool() {
  if (pool) return pool;
  const url = process.env.MEMORIA_PG_URL;
  if (!url) throw new Error('MEMORIA_PG_URL is required for the multi server');
  pool = new Pool({
    connectionString: url,
    max: Number(process.env.MEMORIA_PG_POOL ?? 10),
  });
  return pool;
}

export async function query(text, values = []) {
  const p = openPool();
  return p.query(text, values);
}

// ── shareable resources ────────────────────────────────────────────────────

export async function listSharedBookmarks({ limit = 50, before = null } = {}) {
  const args = [];
  let where = 'WHERE hidden_at IS NULL';
  if (before) { args.push(before); where += ` AND shared_at < $${args.length}`; }
  args.push(limit);
  const r = await query(
    `SELECT b.id, b.url, b.title, b.summary, b.memo,
            b.owner_user_id, b.owner_user_name,
            b.shared_at, b.shared_origin,
            COALESCE(
              (SELECT json_agg(category ORDER BY category)
                 FROM bookmark_categories WHERE bookmark_id = b.id), '[]'::json
            ) AS categories
       FROM bookmarks b
       ${where}
       ORDER BY shared_at DESC
       LIMIT $${args.length}`,
    args,
  );
  return r.rows;
}

export async function insertSharedBookmark({ url, title, summary, memo, categories, ownerUserId, ownerUserName, sharedOrigin }) {
  const r = await query(
    `INSERT INTO bookmarks (url, title, summary, memo, owner_user_id, owner_user_name, shared_origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, shared_at`,
    [url, title, summary ?? null, memo ?? '', ownerUserId, ownerUserName, sharedOrigin ?? null],
  );
  const id = r.rows[0].id;
  for (const cat of (categories || [])) {
    await query(
      `INSERT INTO bookmark_categories (bookmark_id, category) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
      [id, cat],
    );
  }
  return { id, shared_at: r.rows[0].shared_at };
}

export async function deleteSharedBookmark(id, { actingUserId, role }) {
  const r = await query('SELECT owner_user_id FROM bookmarks WHERE id = $1', [id]);
  if (!r.rowCount) return { ok: false, error: 'not_found' };
  const owner = r.rows[0].owner_user_id;
  if (owner !== actingUserId && role !== 'admin' && role !== 'moderator') {
    return { ok: false, error: 'forbidden' };
  }
  await query('DELETE FROM bookmarks WHERE id = $1', [id]);
  await query(
    `INSERT INTO share_log (resource_kind, resource_id, action, acting_user_id)
       VALUES ('bookmark', $1, 'delete', $2)`,
    [id, actingUserId],
  );
  return { ok: true };
}

export async function listSharedDigs({ limit = 50, before = null } = {}) {
  const args = [];
  let where = 'WHERE hidden_at IS NULL';
  if (before) { args.push(before); where += ` AND shared_at < $${args.length}`; }
  args.push(limit);
  const r = await query(
    `SELECT id, query, status, result_json, owner_user_id, owner_user_name,
            shared_at, shared_origin
       FROM dig_sessions
       ${where}
       ORDER BY shared_at DESC
       LIMIT $${args.length}`,
    args,
  );
  return r.rows;
}

export async function insertSharedDig({ query: q, status, result, ownerUserId, ownerUserName, sharedOrigin }) {
  const r = await query(
    `INSERT INTO dig_sessions (query, status, result_json, owner_user_id, owner_user_name, shared_origin)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, shared_at`,
    [q, status, result ? JSON.stringify(result) : null, ownerUserId, ownerUserName, sharedOrigin ?? null],
  );
  return { id: r.rows[0].id, shared_at: r.rows[0].shared_at };
}

export async function deleteSharedDig(id, { actingUserId, role }) {
  const r = await query('SELECT owner_user_id FROM dig_sessions WHERE id = $1', [id]);
  if (!r.rowCount) return { ok: false, error: 'not_found' };
  const owner = r.rows[0].owner_user_id;
  if (owner !== actingUserId && role !== 'admin' && role !== 'moderator') {
    return { ok: false, error: 'forbidden' };
  }
  await query('DELETE FROM dig_sessions WHERE id = $1', [id]);
  await query(
    `INSERT INTO share_log (resource_kind, resource_id, action, acting_user_id)
       VALUES ('dig', $1, 'delete', $2)`,
    [id, actingUserId],
  );
  return { ok: true };
}

export async function listSharedDictionary({ limit = 100, q = null } = {}) {
  const args = [];
  let where = 'WHERE hidden_at IS NULL';
  if (q) {
    args.push(`%${q}%`);
    where += ` AND (term ILIKE $${args.length} OR definition ILIKE $${args.length})`;
  }
  args.push(limit);
  const r = await query(
    `SELECT id, term, definition, notes, owner_user_id, owner_user_name,
            shared_at, shared_origin
       FROM dictionary_entries
       ${where}
       ORDER BY shared_at DESC
       LIMIT $${args.length}`,
    args,
  );
  return r.rows;
}

export async function insertSharedDictionary({ term, definition, notes, ownerUserId, ownerUserName, sharedOrigin }) {
  const r = await query(
    `INSERT INTO dictionary_entries (term, definition, notes, owner_user_id, owner_user_name, shared_origin)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (owner_user_id, term)
         DO UPDATE SET definition = EXCLUDED.definition,
                       notes      = EXCLUDED.notes,
                       updated_at = now(),
                       shared_at  = now(),
                       shared_origin = EXCLUDED.shared_origin
       RETURNING id, shared_at`,
    [term, definition ?? null, notes ?? null, ownerUserId, ownerUserName, sharedOrigin ?? null],
  );
  return { id: r.rows[0].id, shared_at: r.rows[0].shared_at };
}

export async function deleteSharedDictionary(id, { actingUserId, role }) {
  const r = await query('SELECT owner_user_id FROM dictionary_entries WHERE id = $1', [id]);
  if (!r.rowCount) return { ok: false, error: 'not_found' };
  const owner = r.rows[0].owner_user_id;
  if (owner !== actingUserId && role !== 'admin' && role !== 'moderator') {
    return { ok: false, error: 'forbidden' };
  }
  await query('DELETE FROM dictionary_entries WHERE id = $1', [id]);
  await query(
    `INSERT INTO share_log (resource_kind, resource_id, action, acting_user_id)
       VALUES ('dict', $1, 'delete', $2)`,
    [id, actingUserId],
  );
  return { ok: true };
}

// ── moderation (Phase 6 surface, used here only for share_log writes) ──────

export async function recordShareEvent({ kind, id, action, actingUserId, details }) {
  await query(
    `INSERT INTO share_log (resource_kind, resource_id, action, acting_user_id, details_json)
       VALUES ($1, $2, $3, $4, $5)`,
    [kind, id, action, actingUserId, details ? JSON.stringify(details) : null],
  );
}
