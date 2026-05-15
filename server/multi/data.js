// data.js — Multi 対応 7 型の汎用 JSON CRUD (二層設計 Phase 3)。
//
// 旧 /api/shared/* は型ごとに微妙に違う insert/list 関数を持っていたが、
// /api/data/* はテーブル仕様 (TYPES) 駆動の汎用 CRUD に統一する。
//
// 各テーブルは owner_user_id / owner_user_name / shared_at / shared_origin /
// hidden_at を共通で持つ前提。 PATCH / DELETE は owner 本人か admin/moderator のみ。
//
// 旧 /api/shared/* は Phase 6 まで残すので、 ここは完全に別経路。

import { query } from './db.js';

// type slug → テーブル仕様。
//   table       Postgres テーブル名
//   idType      'int' (BIGSERIAL) | 'text' (クライアント供給の uuid 等)
//   cols        書き込み可能なカラム (id は idType='text' のときだけ含める)
//   required    create 時に必須のカラム
//   jsonCols    JSON 値を JSON.stringify して入れるカラム
//   select      list/get/returning で使う SELECT 句
//   orderBy     list のソート
//   searchCols  ?q= で ILIKE 検索するカラム (任意)
//   updatedAtCol  update 時に now() で更新するカラム (任意)
//   hasCategories bookmark_categories 連結 (bookmarks のみ)
const TYPES = {
  bookmarks: {
    table: 'bookmarks', idType: 'int', hasCategories: true,
    cols: ['url', 'title', 'summary', 'memo'],
    required: ['url', 'title'],
    searchCols: ['title', 'url'],
    select: 'id, url, title, summary, memo, owner_user_id, owner_user_name, shared_at, shared_origin',
    orderBy: 'shared_at DESC',
  },
  digs: {
    table: 'dig_sessions', idType: 'int',
    cols: ['query', 'status', 'result_json'],
    jsonCols: ['result_json'],
    required: ['query', 'status'],
    select: 'id, query, status, result_json, owner_user_id, owner_user_name, shared_at, shared_origin',
    orderBy: 'shared_at DESC',
  },
  dictionary: {
    table: 'dictionary_entries', idType: 'int', updatedAtCol: 'updated_at',
    cols: ['term', 'definition', 'notes'],
    required: ['term'],
    searchCols: ['term', 'definition'],
    select: 'id, term, definition, notes, owner_user_id, owner_user_name, shared_at, shared_origin',
    orderBy: 'shared_at DESC',
  },
  'implementation-notes': {
    table: 'implementation_notes', idType: 'int',
    cols: ['product', 'title', 'good_points', 'bad_points', 'attachment_type', 'attachment_value'],
    required: ['title'],
    select: 'id, product, title, good_points, bad_points, attachment_type, attachment_value, '
      + 'owner_user_id, owner_user_name, shared_at, shared_origin',
    orderBy: 'shared_at DESC',
  },
  'work-locations': {
    table: 'work_locations', idType: 'int',
    cols: ['name', 'address', 'latitude', 'longitude', 'description', 'url', 'tags'],
    required: ['name'],
    searchCols: ['name', 'address'],
    select: 'id, name, address, latitude, longitude, description, url, tags, '
      + 'owner_user_id, owner_user_name, shared_at, shared_origin',
    orderBy: 'shared_at DESC',
  },
  'domain-catalog': {
    table: 'domain_catalog', idType: 'int',
    cols: ['domain', 'title', 'site_name', 'description', 'can_do', 'kind', 'notes'],
    required: ['domain'],
    searchCols: ['domain', 'site_name', 'description'],
    select: 'id, domain, title, site_name, description, can_do, kind, notes, '
      + 'owner_user_id, owner_user_name, shared_at, shared_origin',
    orderBy: 'shared_at DESC',
  },
  notes: {
    table: 'notes', idType: 'text', updatedAtCol: 'updated_at',
    cols: ['id', 'title', 'kind', 'tags_json', 'blocks_json', 'bookmark_url',
      'source_kind', 'source_ref', 'created_at'],
    jsonCols: ['tags_json', 'blocks_json'],
    required: ['id'],
    searchCols: ['title'],
    select: 'id, title, kind, tags_json, blocks_json, bookmark_url, source_kind, source_ref, '
      + 'created_at, updated_at, owner_user_id, owner_user_name, shared_at, shared_origin',
    orderBy: 'updated_at DESC',
  },
};

export const DATA_TYPES = Object.keys(TYPES);

function spec(type) {
  const s = TYPES[type];
  if (!s) {
    const e = new Error(`unknown data type: ${type}`);
    e.status = 404;
    throw e;
  }
  return s;
}

function coerceId(s, id) {
  if (s.idType === 'int') {
    const n = Number(id);
    if (!Number.isInteger(n)) {
      const e = new Error('invalid id');
      e.status = 400;
      throw e;
    }
    return n;
  }
  return String(id);
}

function canModify(ownerId, actor) {
  return ownerId === actor.userId || actor.role === 'admin' || actor.role === 'moderator';
}

/** col の値を INSERT/UPDATE 用に整形。 undefined はそのカラムを「触らない」 印。 */
function prepValue(s, col, val) {
  if (val === undefined) return undefined;
  if ((s.jsonCols || []).includes(col)) return val == null ? null : JSON.stringify(val);
  return val ?? null;
}

// ── bookmark_categories の連結 ─────────────────────────────────────────────

async function attachCategories(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const r = await query(
    `SELECT bookmark_id, category FROM bookmark_categories
       WHERE bookmark_id = ANY($1) ORDER BY category`,
    [ids],
  );
  const byId = new Map();
  for (const row of r.rows) {
    if (!byId.has(row.bookmark_id)) byId.set(row.bookmark_id, []);
    byId.get(row.bookmark_id).push(row.category);
  }
  return rows.map((row) => ({ ...row, categories: byId.get(row.id) || [] }));
}

async function setCategories(bookmarkId, categories) {
  await query('DELETE FROM bookmark_categories WHERE bookmark_id = $1', [bookmarkId]);
  for (const cat of categories) {
    if (!cat) continue;
    await query(
      `INSERT INTO bookmark_categories (bookmark_id, category) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
      [bookmarkId, cat],
    );
  }
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export async function listData(type, { limit = 50, offset = 0, q = null } = {}) {
  const s = spec(type);
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const args = [];
  let where = 'WHERE hidden_at IS NULL';
  if (q && s.searchCols) {
    args.push(`%${q}%`);
    where += ` AND (${s.searchCols.map((col) => `${col} ILIKE $1`).join(' OR ')})`;
  }
  args.push(lim, off);
  const r = await query(
    `SELECT ${s.select} FROM ${s.table} ${where}
       ORDER BY ${s.orderBy} LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args,
  );
  if (s.hasCategories) return attachCategories(r.rows);
  return r.rows;
}

export async function getData(type, id) {
  const s = spec(type);
  const cid = coerceId(s, id);
  const r = await query(
    `SELECT ${s.select} FROM ${s.table} WHERE id = $1 AND hidden_at IS NULL`,
    [cid],
  );
  if (!r.rowCount) return null;
  if (s.hasCategories) return (await attachCategories([r.rows[0]]))[0];
  return r.rows[0];
}

export async function createData(type, fields, owner) {
  const s = spec(type);
  for (const req of s.required) {
    if (fields[req] == null || fields[req] === '') {
      const e = new Error(`${req} is required`);
      e.status = 400;
      throw e;
    }
  }
  const cols = ['owner_user_id', 'owner_user_name', 'shared_origin'];
  const vals = [owner.userId, owner.displayName, owner.sharedOrigin ?? null];
  for (const col of s.cols) {
    if (col === 'id' && s.idType !== 'text') continue; // BIGSERIAL は供給しない
    const v = prepValue(s, col, fields[col]);
    if (v !== undefined) {
      cols.push(col);
      vals.push(v);
    }
  }
  const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
  let r;
  try {
    r = await query(
      `INSERT INTO ${s.table} (${cols.join(', ')}) VALUES (${ph}) RETURNING ${s.select}`,
      vals,
    );
  } catch (err) {
    if (err?.code === '23505') { // unique_violation
      const e = new Error('duplicate');
      e.status = 409;
      throw e;
    }
    throw err;
  }
  let row = r.rows[0];
  if (s.hasCategories) {
    if (Array.isArray(fields.categories)) {
      await setCategories(row.id, fields.categories);
      [row] = await attachCategories([row]);
    } else {
      row = { ...row, categories: [] };
    }
  }
  return row;
}

export async function updateData(type, id, fields, actor) {
  const s = spec(type);
  const cid = coerceId(s, id);
  const cur = await query(`SELECT owner_user_id FROM ${s.table} WHERE id = $1`, [cid]);
  if (!cur.rowCount) return { ok: false, error: 'not_found' };
  if (!canModify(cur.rows[0].owner_user_id, actor)) return { ok: false, error: 'forbidden' };

  // 値カラムの SET 句を組み立てる (id / updatedAtCol は除外、 渡されたものだけ)。
  const sets = [];
  const vals = [];
  for (const col of s.cols) {
    if (col === 'id' || col === s.updatedAtCol) continue;
    if (!(col in fields)) continue;
    vals.push(prepValue(s, col, fields[col]));
    sets.push(`${col} = $${vals.length}`);
  }
  if (sets.length > 0 && s.updatedAtCol) sets.push(`${s.updatedAtCol} = now()`);

  if (sets.length > 0) {
    vals.push(cid);
    await query(`UPDATE ${s.table} SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  } else if (s.updatedAtCol && Array.isArray(fields.categories)) {
    // 値カラムは無いが categories だけ来た → updatedAtCol だけ touch
    await query(`UPDATE ${s.table} SET ${s.updatedAtCol} = now() WHERE id = $1`, [cid]);
  }
  if (s.hasCategories && Array.isArray(fields.categories)) {
    await setCategories(cid, fields.categories);
  }
  return { ok: true, row: await getData(type, id) };
}

export async function deleteData(type, id, actor) {
  const s = spec(type);
  const cid = coerceId(s, id);
  const cur = await query(`SELECT owner_user_id FROM ${s.table} WHERE id = $1`, [cid]);
  if (!cur.rowCount) return { ok: false, error: 'not_found' };
  if (!canModify(cur.rows[0].owner_user_id, actor)) return { ok: false, error: 'forbidden' };
  await query(`DELETE FROM ${s.table} WHERE id = $1`, [cid]);
  return { ok: true };
}
