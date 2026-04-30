// Apply Postgres migrations in order.
//
// Each .sql file in ./migrations is applied exactly once; we track the
// applied set in a `_migrations` table.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPool } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = join(__dirname, 'migrations');

async function main() {
  const pool = openPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const files = readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await pool.query('SELECT filename FROM _migrations')).rows.map(r => r.filename),
  );

  for (const f of files) {
    if (applied.has(f)) {
      console.log(`✓ ${f} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(MIG_DIR, f), 'utf8');
    console.log(`→ ${f}`);
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations (filename) VALUES ($1)', [f]);
      await pool.query('COMMIT');
      console.log(`✓ ${f}`);
    } catch (e) {
      await pool.query('ROLLBACK');
      console.error(`✗ ${f}: ${e.message}`);
      process.exit(1);
    }
  }
  await pool.end();
  console.log('done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
