import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import {
  checkNotionTransfer,
  type NotionTransferArticle,
} from '../ai-hub/notion-transfer-check.js';
import {
  buildNotionTransferReport,
  formatNotionTransferReport,
} from '../ai-hub/notion-transfer-report.js';

function readOption(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function ensureTable(db: Database.Database, table: string): void {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!row) throw new Error(`required table is missing: ${table}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const dbPath = resolve(readOption(args, '--db') ?? '../data/memoria.db');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    db.pragma('query_only = ON');
    ensureTable(db, 'ai_articles');
    ensureTable(db, 'achievement_redaction_terms');

    const articles = db.prepare(`
      SELECT id, title, body_md
      FROM ai_articles
      ORDER BY id
    `).all() as NotionTransferArticle[];
    const forbiddenTerms = (db.prepare(`
      SELECT term
      FROM achievement_redaction_terms
      ORDER BY term
    `).all() as { term: string }[]).map((row) => row.term);
    const report = buildNotionTransferReport(
      articles.map((article) => checkNotionTransfer(article, forbiddenTerms)),
      forbiddenTerms.length,
    );

    if (forbiddenTerms.length === 0) {
      process.stderr.write('Warning: achievement_redaction_terms is empty; only built-in safety checks ran.\n');
    }
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(formatNotionTransferReport(report));
  } finally {
    db.close();
  }
}

main();
