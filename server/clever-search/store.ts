import type BetterSqlite3 from 'better-sqlite3';
import type {
  CleverSearchHit,
  CleverSearchReport,
  StoredCleverSearchReport,
} from './types.js';

type Db = BetterSqlite3.Database;

export function normalizeCleverSearchQuery(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ja-JP');
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function searchTerms(normalizedQuery: string): string[] {
  return normalizedQuery.split(' ').map((term) => term.trim()).filter(Boolean);
}

function ftsQuery(terms: string[]): string {
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' AND ');
}

export function searchCleverDocuments(db: Db, normalizedQuery: string): CleverSearchHit[] {
  const terms = searchTerms(normalizedQuery);
  if (terms.length === 0) return [];

  if (terms.every((term) => codePointLength(term) >= 3)) {
    return db.prepare(`
      SELECT s.id, s.source_type, s.source_id, s.report_category,
             s.title, s.content, s.occurred_at, s.source_subtype,
             bm25(clever_search_fts, 6.0, 1.0) AS score
        FROM clever_search_fts
        JOIN clever_search_sources s ON s.id = clever_search_fts.rowid
       WHERE clever_search_fts MATCH ?
       ORDER BY score ASC, s.occurred_at DESC
    `).all(ftsQuery(terms)) as CleverSearchHit[];
  }

  const predicates = terms.map(() => `(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')`);
  const params = terms.flatMap((term) => {
    const escaped = term.replace(/([%_\\])/g, '\\$1');
    return [`%${escaped}%`, `%${escaped}%`];
  });
  return db.prepare(`
    SELECT id, source_type, source_id, report_category,
           title, content, occurred_at, source_subtype, 0.0 AS score
      FROM clever_search_sources
     WHERE ${predicates.join(' AND ')}
     ORDER BY occurred_at DESC
  `).all(...params) as CleverSearchHit[];
}

export function findCachedCleverSearchReport(
  db: Db,
  normalizedQuery: string,
): StoredCleverSearchReport | undefined {
  return db.prepare(`
    SELECT id, query, normalized_query, total_hits, report_json,
           search_elapsed_ms, created_at
      FROM clever_search_reports
     WHERE normalized_query = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  `).get(normalizedQuery) as StoredCleverSearchReport | undefined;
}

export function getCleverSearchReport(db: Db, id: number): StoredCleverSearchReport | undefined {
  return db.prepare(`
    SELECT id, query, normalized_query, total_hits, report_json,
           search_elapsed_ms, created_at
      FROM clever_search_reports
     WHERE id = ?
  `).get(id) as StoredCleverSearchReport | undefined;
}

export function saveCleverSearchReport(db: Db, report: CleverSearchReport): number {
  const result = db.prepare(`
    INSERT INTO clever_search_reports (
      query, normalized_query, total_hits, report_json, search_elapsed_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    report.query,
    report.normalizedQuery,
    report.totalHits,
    JSON.stringify(report),
    report.searchElapsedMs,
    report.createdAt,
  );
  return Number(result.lastInsertRowid);
}

export interface CleverSearchHistoryRow {
  id: number;
  query: string;
  total_hits: number;
  search_elapsed_ms: number;
  created_at: string;
}

export function listCleverSearchReports(db: Db, limit: number): CleverSearchHistoryRow[] {
  return db.prepare(`
    SELECT id, query, total_hits, search_elapsed_ms, created_at
      FROM clever_search_reports
     ORDER BY created_at DESC, id DESC
     LIMIT ?
  `).all(limit) as CleverSearchHistoryRow[];
}

export function parseStoredCleverSearchReport(row: StoredCleverSearchReport): CleverSearchReport {
  const parsed = JSON.parse(row.report_json) as CleverSearchReport;
  if (parsed.version !== 1 || !Array.isArray(parsed.categories)) {
    throw new Error(`unsupported clever search report format for report ${row.id}`);
  }
  return parsed;
}
