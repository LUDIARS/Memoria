import type BetterSqlite3 from 'better-sqlite3';
import type { CleverSearchCategory } from './types.js';

type Db = BetterSqlite3.Database;

interface SourceSpec {
  key: string;
  table: string;
  sourceType: string;
  category: CleverSearchCategory;
  id: (row: string) => string;
  title: (row: string) => string;
  content: (row: string) => string;
  occurredAt: (row: string) => string;
  subtype: (row: string) => string;
}

const text = (expression: string): string => `COALESCE(CAST(${expression} AS TEXT), '')`;
const joinText = (...expressions: string[]): string =>
  expressions.map(text).join(' || char(10) || ');

const SOURCE_SPECS: SourceSpec[] = [
  {
    key: 'bookmark',
    table: 'bookmarks',
    sourceType: 'bookmark',
    category: 'knowledge',
    id: (r) => `${r}.id`,
    title: (r) => text(`${r}.title`),
    content: (r) => joinText(
      `${r}.url`,
      `${r}.summary`,
      `${r}.memo`,
      `(SELECT group_concat(bc.category, ' ') FROM bookmark_categories bc WHERE bc.bookmark_id = ${r}.id)`,
    ),
    occurredAt: (r) => `COALESCE(${r}.updated_at, ${r}.created_at)`,
    subtype: () => `'bookmark'`,
  },
  {
    key: 'dig',
    table: 'dig_sessions',
    sourceType: 'dig',
    category: 'knowledge',
    id: (r) => `${r}.id`,
    title: (r) => text(`${r}.query`),
    content: (r) => joinText(`${r}.theme`, `${r}.result_json`, `${r}.preview_json`, `${r}.raw_results_json`),
    occurredAt: (r) => `${r}.created_at`,
    subtype: (r) => text(`${r}.status`),
  },
  {
    key: 'activity',
    table: 'activity_events',
    sourceType: 'activity',
    category: 'development',
    id: (r) => `${r}.id`,
    title: (r) => joinText(`${r}.kind`, `${r}.source`),
    content: (r) => joinText(`${r}.content`, `${r}.metadata_json`),
    occurredAt: (r) => `${r}.occurred_at`,
    subtype: (r) => text(`${r}.kind`),
  },
  {
    key: 'external_chat',
    table: 'external_chat_messages',
    sourceType: 'external_chat',
    category: 'conversation',
    id: (r) => `${r}.id`,
    title: (r) => joinText(`${r}.source`, `${r}.conversation_id`, `${r}.role`),
    content: (r) => joinText(`${r}.content`, `${r}.metadata_json`),
    occurredAt: (r) => `${r}.received_at`,
    subtype: (r) => text(`${r}.source`),
  },
  {
    key: 'diary',
    table: 'diary_entries',
    sourceType: 'diary',
    category: 'reflection',
    id: (r) => `${r}.date`,
    title: (r) => `'日記 ' || ${text(`${r}.date`)}`,
    content: (r) => joinText(`${r}.summary`, `${r}.work_content`, `${r}.highlights`, `${r}.notes`),
    occurredAt: (r) => `COALESCE(${r}.updated_at, ${r}.date)`,
    subtype: () => `'diary'`,
  },
  {
    key: 'weekly',
    table: 'weekly_reports',
    sourceType: 'weekly_report',
    category: 'reflection',
    id: (r) => `${r}.week_start`,
    title: (r) => `'週報 ' || ${text(`${r}.week_start`)}`,
    content: (r) => joinText(`${r}.summary`, `${r}.github_summary_json`),
    occurredAt: (r) => `COALESCE(${r}.updated_at, ${r}.week_start)`,
    subtype: () => `'weekly'`,
  },
  {
    key: 'dictionary',
    table: 'dictionary_entries',
    sourceType: 'dictionary',
    category: 'knowledge',
    id: (r) => `${r}.id`,
    title: (r) => text(`${r}.term`),
    content: (r) => joinText(`${r}.definition`, `${r}.notes`),
    occurredAt: (r) => `COALESCE(${r}.updated_at, ${r}.created_at)`,
    subtype: () => `'dictionary'`,
  },
  {
    key: 'note',
    table: 'notes',
    sourceType: 'note',
    category: 'knowledge',
    id: (r) => `${r}.id`,
    title: (r) => text(`${r}.title`),
    content: (r) => joinText(
      `${r}.tags_json`,
      `${r}.bookmark_url`,
      `(SELECT group_concat(ordered.text, char(10))
          FROM (
            SELECT nb.text
              FROM note_blocks nb
             WHERE nb.note_id = ${r}.id
             ORDER BY nb.position ASC, nb.id ASC
          ) ordered)`,
    ),
    occurredAt: (r) => `COALESCE(${r}.updated_at, ${r}.created_at)`,
    subtype: (r) => text(`${r}.kind`),
  },
  {
    key: 'task',
    table: 'tasks',
    sourceType: 'task',
    category: 'action',
    id: (r) => `${r}.id`,
    title: (r) => text(`${r}.title`),
    content: (r) => joinText(`${r}.details`, `${r}.category`, `${r}.status`, `${r}.creator_type`),
    occurredAt: (r) => `COALESCE(${r}.updated_at, ${r}.created_at)`,
    subtype: (r) => text(`${r}.kind`),
  },
  {
    key: 'implementation_note',
    table: 'implementation_notes',
    sourceType: 'implementation_note',
    category: 'action',
    id: (r) => `${r}.id`,
    title: (r) => joinText(`${r}.product`, `${r}.title`),
    content: (r) => joinText(`${r}.good_points`, `${r}.bad_points`),
    occurredAt: (r) => `COALESCE(${r}.updated_at, ${r}.created_at)`,
    subtype: (r) => text(`${r}.product`),
  },
];

const UPSERT_UPDATE = `
  ON CONFLICT(source_type, source_id) DO UPDATE SET
    report_category = excluded.report_category,
    title = excluded.title,
    content = excluded.content,
    occurred_at = excluded.occurred_at,
    source_subtype = excluded.source_subtype
  WHERE report_category IS NOT excluded.report_category
     OR title IS NOT excluded.title
     OR content IS NOT excluded.content
     OR occurred_at IS NOT excluded.occurred_at
     OR source_subtype IS NOT excluded.source_subtype`;

function valuesFor(spec: SourceSpec, row: string): string {
  return [
    `'${spec.sourceType}'`,
    `CAST(${spec.id(row)} AS TEXT)`,
    `'${spec.category}'`,
    spec.title(row),
    spec.content(row),
    `COALESCE(${spec.occurredAt(row)}, '')`,
    spec.subtype(row),
  ].join(',\n      ');
}

function sourceUpsertSql(spec: SourceSpec, row: string): string {
  return `
    INSERT INTO clever_search_sources (
      source_type, source_id, report_category, title, content, occurred_at, source_subtype
    ) VALUES (
      ${valuesFor(spec, row)}
    )${UPSERT_UPDATE};`;
}

function deletePreviousSourceSql(spec: SourceSpec): string {
  const previousId = `CAST(${spec.id('OLD')} AS TEXT)`;
  const currentId = `CAST(${spec.id('NEW')} AS TEXT)`;
  return `
    DELETE FROM clever_search_sources
     WHERE source_type = '${spec.sourceType}'
       AND source_id = ${previousId}
       AND ${previousId} IS NOT ${currentId};`;
}

function seedSourceSql(spec: SourceSpec): string {
  return `
    INSERT INTO clever_search_sources (
      source_type, source_id, report_category, title, content, occurred_at, source_subtype
    )
    SELECT ${valuesFor(spec, 'src')}
      FROM ${spec.table} src
     WHERE 1
    ${UPSERT_UPDATE};

    DELETE FROM clever_search_sources
     WHERE source_type = '${spec.sourceType}'
       AND NOT EXISTS (
         SELECT 1 FROM ${spec.table} src
          WHERE CAST(${spec.id('src')} AS TEXT) = clever_search_sources.source_id
       );`;
}

function ensureSourceTriggers(db: Db, spec: SourceSpec): void {
  db.exec(`
    DROP TRIGGER IF EXISTS clever_search_${spec.key}_ai;
    DROP TRIGGER IF EXISTS clever_search_${spec.key}_au;
    DROP TRIGGER IF EXISTS clever_search_${spec.key}_ad;

    CREATE TRIGGER clever_search_${spec.key}_ai
    AFTER INSERT ON ${spec.table}
    BEGIN
      ${sourceUpsertSql(spec, 'NEW')}
    END;

    CREATE TRIGGER clever_search_${spec.key}_au
    AFTER UPDATE ON ${spec.table}
    BEGIN
      ${deletePreviousSourceSql(spec)}
      ${sourceUpsertSql(spec, 'NEW')}
    END;

    CREATE TRIGGER clever_search_${spec.key}_ad
    AFTER DELETE ON ${spec.table}
    BEGIN
      DELETE FROM clever_search_sources
       WHERE source_type = '${spec.sourceType}'
         AND source_id = CAST(${spec.id('OLD')} AS TEXT);
    END;
  `);
}

function refreshRelatedSourceSql(spec: SourceSpec, sourceId: string): string {
  return `
    INSERT INTO clever_search_sources (
      source_type, source_id, report_category, title, content, occurred_at, source_subtype
    )
    SELECT ${valuesFor(spec, 'src')}
      FROM ${spec.table} src
     WHERE CAST(${spec.id('src')} AS TEXT) = CAST(${sourceId} AS TEXT)
    ${UPSERT_UPDATE};`;
}

function ensureRelatedTableTriggers(db: Db): void {
  const bookmark = SOURCE_SPECS.find((spec) => spec.key === 'bookmark');
  const note = SOURCE_SPECS.find((spec) => spec.key === 'note');
  if (!bookmark || !note) throw new Error('clever search source specification missing');

  db.exec(`
    DROP TRIGGER IF EXISTS clever_search_bookmark_category_ai;
    DROP TRIGGER IF EXISTS clever_search_bookmark_category_au;
    DROP TRIGGER IF EXISTS clever_search_bookmark_category_ad;
    DROP TRIGGER IF EXISTS clever_search_note_block_ai;
    DROP TRIGGER IF EXISTS clever_search_note_block_au;
    DROP TRIGGER IF EXISTS clever_search_note_block_ad;

    CREATE TRIGGER clever_search_bookmark_category_ai
    AFTER INSERT ON bookmark_categories
    BEGIN
      ${refreshRelatedSourceSql(bookmark, 'NEW.bookmark_id')}
    END;

    CREATE TRIGGER clever_search_bookmark_category_au
    AFTER UPDATE ON bookmark_categories
    BEGIN
      ${refreshRelatedSourceSql(bookmark, 'OLD.bookmark_id')}
      ${refreshRelatedSourceSql(bookmark, 'NEW.bookmark_id')}
    END;

    CREATE TRIGGER clever_search_bookmark_category_ad
    AFTER DELETE ON bookmark_categories
    BEGIN
      ${refreshRelatedSourceSql(bookmark, 'OLD.bookmark_id')}
    END;

    CREATE TRIGGER clever_search_note_block_ai
    AFTER INSERT ON note_blocks
    BEGIN
      ${refreshRelatedSourceSql(note, 'NEW.note_id')}
    END;

    CREATE TRIGGER clever_search_note_block_au
    AFTER UPDATE ON note_blocks
    BEGIN
      ${refreshRelatedSourceSql(note, 'OLD.note_id')}
      ${refreshRelatedSourceSql(note, 'NEW.note_id')}
    END;

    CREATE TRIGGER clever_search_note_block_ad
    AFTER DELETE ON note_blocks
    BEGIN
      ${refreshRelatedSourceSql(note, 'OLD.note_id')}
    END;
  `);
}

export function ensureCleverSearchSchema(db: Db): void {
  const initialize = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clever_search_sources (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type     TEXT NOT NULL,
        source_id       TEXT NOT NULL,
        report_category TEXT NOT NULL,
        title           TEXT NOT NULL DEFAULT '',
        content         TEXT NOT NULL DEFAULT '',
        occurred_at     TEXT NOT NULL,
        source_subtype  TEXT,
        UNIQUE(source_type, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_clever_search_sources_category_at
        ON clever_search_sources(report_category, occurred_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS clever_search_fts USING fts5(
        title,
        content,
        content='clever_search_sources',
        content_rowid='id',
        tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS clever_search_sources_ai
      AFTER INSERT ON clever_search_sources BEGIN
        INSERT INTO clever_search_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS clever_search_sources_ad
      AFTER DELETE ON clever_search_sources BEGIN
        INSERT INTO clever_search_fts(clever_search_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS clever_search_sources_au
      AFTER UPDATE ON clever_search_sources BEGIN
        INSERT INTO clever_search_fts(clever_search_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
        INSERT INTO clever_search_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END;

      CREATE TABLE IF NOT EXISTS clever_search_reports (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        query             TEXT NOT NULL,
        normalized_query  TEXT NOT NULL,
        total_hits        INTEGER NOT NULL,
        report_json       TEXT NOT NULL,
        search_elapsed_ms INTEGER NOT NULL,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_clever_search_reports_query_created
        ON clever_search_reports(normalized_query, created_at DESC, id DESC);
    `);

    for (const spec of SOURCE_SPECS) ensureSourceTriggers(db, spec);
    ensureRelatedTableTriggers(db);
    for (const spec of SOURCE_SPECS) db.exec(seedSourceSql(spec));
  });

  try {
    initialize();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`clever search index initialization failed: ${message}`, { cause: error });
  }
}
