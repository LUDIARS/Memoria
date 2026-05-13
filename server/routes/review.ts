// /api/review/* — LUDIARS 全リポの review/ フォルダを横断閲覧する。
//
// Skill `ludiars-review` が各リポの `review/<YYYY-MM-DD>/REVIEW_*.md` と
// `review/latest.json` を書き出す。 このルータはそれをファイルシステム
// 経由でそのまま返すだけ (DB は使わない)。

import { Hono, type Context } from 'hono';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const LUDIARS_ROOT = resolve(process.env.LUDIARS_ROOT ?? 'E:/Document/Ars');

const REVIEW_FILES = [
  'REVIEW.md',
  'REVIEW_DESIGN.md',
  'REVIEW_VULNERABILITY.md',
  'REVIEW_IMPLEMENTATION.md',
  'REVIEW_MISSING_FEATURES.md',
  'REVIEW_QUALITY.md',
] as const;

type ReviewFile = typeof REVIEW_FILES[number];

interface LatestJson {
  date: string;
  weighted_score?: string;
  scores?: Record<string, string>;
  critical_count?: number;
  high_count?: number;
  fix_pr?: string | null;
}

function safeRepoName(name: string): string | null {
  // path traversal 防止 — 英数字 / ハイフン / アンダースコア / ドットのみ許可、 先頭ドット禁止
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return null;
  if (name.includes('..')) return null;
  return name;
}

function safeDate(s: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function safeFile(name: string): ReviewFile | null {
  return (REVIEW_FILES as readonly string[]).includes(name) ? (name as ReviewFile) : null;
}

function reviewDir(repo: string): string {
  return join(LUDIARS_ROOT, repo, 'review');
}

function readLatest(repo: string): LatestJson | null {
  const p = join(reviewDir(repo), 'latest.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as LatestJson; } catch { return null; }
}

function listDates(repo: string): string[] {
  const dir = reviewDir(repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => safeDate(n) && statSync(join(dir, n)).isDirectory())
    .sort()
    .reverse();
}

function listReviewedRepos(): string[] {
  if (!existsSync(LUDIARS_ROOT)) return [];
  const out: string[] = [];
  for (const name of readdirSync(LUDIARS_ROOT)) {
    if (!safeRepoName(name)) continue;
    const dir = reviewDir(name);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    // review/ フォルダがあっても日付サブディレクトリが 1 件も無い場合は
    // 一覧に出さない (= Actio と Actio.cocoiru のように同一 remote の別 clone で
    // pull タイミングがずれて空の review/ だけが残っている worktree 対策)。
    const hasDates = readdirSync(dir).some(
      (n) => safeDate(n) && statSync(join(dir, n)).isDirectory(),
    );
    if (hasDates) out.push(name);
  }
  return out.sort();
}

export function makeReviewRouter(): Hono {
  const r = new Hono();

  r.get('/api/review/repos', (c: Context) => {
    const items = listReviewedRepos().map((repo) => {
      const latest = readLatest(repo);
      return {
        repo,
        latest_date: latest?.date ?? null,
        weighted_score: latest?.weighted_score ?? null,
        critical_count: latest?.critical_count ?? 0,
        high_count: latest?.high_count ?? 0,
        fix_pr: latest?.fix_pr ?? null,
      };
    });
    return c.json({ items, root: LUDIARS_ROOT });
  });

  r.get('/api/review/repos/:repo', (c: Context) => {
    const repo = safeRepoName(c.req.param('repo') ?? '');
    if (!repo) return c.json({ error: 'invalid repo' }, 400);
    const dates = listDates(repo);
    const latest = readLatest(repo);
    return c.json({ repo, dates, latest });
  });

  r.get('/api/review/repos/:repo/:date/:file', (c: Context) => {
    const repo = safeRepoName(c.req.param('repo') ?? '');
    const date = safeDate(c.req.param('date') ?? '');
    const file = safeFile(c.req.param('file') ?? '');
    if (!repo || !date || !file) return c.json({ error: 'invalid path' }, 400);
    const p = join(reviewDir(repo), date, file);
    if (!existsSync(p)) return c.json({ error: 'not_found' }, 404);
    const text = readFileSync(p, 'utf8');
    return c.body(text, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  });

  return r;
}
