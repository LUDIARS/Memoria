import type BetterSqlite3 from 'better-sqlite3';
import { PARSER_VERSION } from './native-log-reader.js';
import type { SourceSignature } from './types.js';

type Db = BetterSqlite3.Database;

interface SourceRow { modified_ms: number; size_bytes: number; error: string | null; parser_version: number }

/** A source is current only if the file is unchanged and the current parser read it. */
export function isSourceCurrent(db: Db, source: SourceSignature): boolean {
  const row = db.prepare(
    'SELECT modified_ms, size_bytes, error, parser_version FROM llm_usage_sources WHERE source_path = ?',
  ).get(source.path) as SourceRow | undefined;
  return !!row && row.error === null && row.parser_version === PARSER_VERSION
    && row.modified_ms === source.modifiedMs && row.size_bytes === source.sizeBytes;
}

export function markSourceImported(
  db: Db,
  source: SourceSignature,
  sessionId: string,
  importedAt: string,
): void {
  db.prepare(`
    INSERT INTO llm_usage_sources (
      source_path, provider, session_id, modified_ms, size_bytes, imported_at, error, parser_version
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(source_path) DO UPDATE SET
      provider=excluded.provider, session_id=excluded.session_id,
      modified_ms=excluded.modified_ms, size_bytes=excluded.size_bytes,
      imported_at=excluded.imported_at, error=NULL, parser_version=excluded.parser_version
  `).run(source.path, source.provider, sessionId, source.modifiedMs, source.sizeBytes, importedAt, PARSER_VERSION);
}

export function recordSourceFailure(
  db: Db,
  source: SourceSignature,
  error: string,
  importedAt = new Date().toISOString(),
): void {
  db.prepare(`
    INSERT INTO llm_usage_sources (
      source_path, provider, session_id, modified_ms, size_bytes, imported_at, error, parser_version
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET
      modified_ms=excluded.modified_ms, size_bytes=excluded.size_bytes,
      imported_at=excluded.imported_at, error=excluded.error, parser_version=excluded.parser_version
  `).run(
    source.path, source.provider, source.modifiedMs, source.sizeBytes, importedAt,
    error.slice(0, 500), PARSER_VERSION,
  );
}
