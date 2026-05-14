// Postgres adapter for the Memoria Hub.
//
// 二層設計では Hub のデータアクセスは data.js (Multi 対応 7 型の汎用 CRUD) に
// 集約されている。 このモジュールは接続プールと低レベル query だけを提供する。
// 旧 /api/shared/* 用の型ごと関数群は Phase 6 で撤去した。
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
