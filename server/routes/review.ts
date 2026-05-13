// /api/review/* — レビュー対象 (`review_targets` テーブル) と、 各ターゲットの
// ローカル clone にある `review/<YYYY-MM-DD>/` 配下のファイルを返す API。
//
// データソース:
//   - SQLite テーブル `review_targets` で 「どのリポを対象に listing するか」 を管理
//   - 各ターゲットの local_path 配下 `review/` フォルダから日付ディレクトリ・
//     latest.json・各 REVIEW_*.md を読む
//
// 起動時に `LUDIARS_ROOT` (= E:/Document/Ars) を走査して LUDIARS clone を
// 自動 seed する (init.ts から `seedReviewTargets` を呼ぶ)。

import { Hono, type Context } from 'hono';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, isAbsolute } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import {
  listReviewTargets, getReviewTargetByName, insertReviewTarget,
  insertReviewTargetIfMissing, updateReviewTarget, deleteReviewTarget,
  type ReviewTargetRow,
} from '../db.js';

type Db = BetterSqlite3.Database;

const LUDIARS_ROOT = resolve(process.env.LUDIARS_ROOT ?? 'E:/Document/Ars');
const SUPPORTED_FORMATS = new Set(['aiformat']);

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

function safeDate(s: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function safeFile(name: string): ReviewFile | null {
  return (REVIEW_FILES as readonly string[]).includes(name) ? (name as ReviewFile) : null;
}

/** ターゲットの local_path を絶対パスに解決 (= 相対なら LUDIARS_ROOT 起点)。 */
function resolveTargetPath(target: ReviewTargetRow): string {
  return isAbsolute(target.local_path) ? target.local_path : resolve(LUDIARS_ROOT, target.local_path);
}

function reviewDir(target: ReviewTargetRow): string {
  return join(resolveTargetPath(target), 'review');
}

function readLatest(target: ReviewTargetRow): LatestJson | null {
  const p = join(reviewDir(target), 'latest.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as LatestJson; } catch { return null; }
}

/** 指定日付の `review/<date>/latest.json` を読む。 無ければ null。 */
function readDateLatest(target: ReviewTargetRow, date: string): LatestJson | null {
  const p = join(reviewDir(target), date, 'latest.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as LatestJson; } catch { return null; }
}

function listDates(target: ReviewTargetRow): string[] {
  const dir = reviewDir(target);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => safeDate(n) && statSync(join(dir, n)).isDirectory())
    .sort()
    .reverse();
}

/** 起動時に LUDIARS_ROOT 配下の git clone を walk し、 github.com/LUDIARS/<Name>
 *  remote を持つものを review_targets に挿入する。 既存はスキップ。 */
export function seedReviewTargets(db: Db): { seeded: number; skipped: number } {
  if (!existsSync(LUDIARS_ROOT)) return { seeded: 0, skipped: 0 };
  let seeded = 0;
  let skipped = 0;
  // 同じ remote URL の別 clone (worktree / fork) を排除するため、 URL でユニーク化
  const seenUrls = new Set<string>();
  for (const name of readdirSync(LUDIARS_ROOT).sort()) {
    const full = join(LUDIARS_ROOT, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let url = '';
    try {
      url = execSync('git config --get remote.origin.url', { cwd: full, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
    } catch { continue; }
    if (!/github\.com[/:]LUDIARS\//i.test(url)) continue;
    if (seenUrls.has(url)) { skipped++; continue; }
    seenUrls.add(url);
    const inserted = insertReviewTargetIfMissing(db, {
      name,
      local_path: full,
      format_key: 'aiformat',
    });
    if (inserted) seeded++; else skipped++;
  }
  return { seeded, skipped };
}

export interface ReviewRouterDeps { db: Db }

export function makeReviewRouter(deps: ReviewRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  // ── target CRUD ────────────────────────────────────────────────────────
  r.get('/api/review/targets', (c: Context) => {
    const items = listReviewTargets(db);
    return c.json({ items, ludiars_root: LUDIARS_ROOT, formats: [...SUPPORTED_FORMATS] });
  });

  r.post('/api/review/targets', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as {
      name?: unknown; local_path?: unknown; format_key?: unknown;
    } | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const local_path = typeof body?.local_path === 'string' ? body.local_path.trim() : '';
    const format_key = typeof body?.format_key === 'string' ? body.format_key.trim() : 'aiformat';
    if (!name) return c.json({ error: 'name required' }, 400);
    if (!local_path) return c.json({ error: 'local_path required' }, 400);
    if (!SUPPORTED_FORMATS.has(format_key)) return c.json({ error: `unsupported format: ${format_key}` }, 400);
    // 相対なら LUDIARS_ROOT 起点で絶対化して存在を確認
    const abs = isAbsolute(local_path) ? local_path : resolve(LUDIARS_ROOT, local_path);
    if (!existsSync(abs)) return c.json({ error: `local_path not found: ${abs}` }, 400);
    if (!statSync(abs).isDirectory()) return c.json({ error: 'local_path is not a directory' }, 400);
    // 同名・同 path をブロック
    if (getReviewTargetByName(db, name)) return c.json({ error: `name already taken: ${name}` }, 409);
    try {
      const id = insertReviewTarget(db, { name, local_path: abs, format_key });
      return c.json({ id, name, local_path: abs, format_key }, 201);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `insert failed: ${msg}` }, 500);
    }
  });

  r.patch('/api/review/targets/:id', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const body = await c.req.json().catch(() => ({})) as {
      name?: unknown; local_path?: unknown; format_key?: unknown; enabled?: unknown;
    };
    const patch: { name?: string; local_path?: string; format_key?: string; enabled?: 0 | 1 } = {};
    if (typeof body.name === 'string') patch.name = body.name.trim();
    if (typeof body.local_path === 'string') patch.local_path = body.local_path.trim();
    if (typeof body.format_key === 'string') {
      if (!SUPPORTED_FORMATS.has(body.format_key)) return c.json({ error: 'unsupported format' }, 400);
      patch.format_key = body.format_key;
    }
    if (body.enabled === true || body.enabled === 1) patch.enabled = 1;
    if (body.enabled === false || body.enabled === 0) patch.enabled = 0;
    updateReviewTarget(db, id, patch);
    return c.json({ ok: true });
  });

  r.delete('/api/review/targets/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const ok = deleteReviewTarget(db, id);
    return c.json({ ok });
  });

  // ── 全 enabled ターゲットを横断したレビュー日付一覧。 新しい順。
  // UI の 「日付フィルタ」 を populate するのに使う。
  r.get('/api/review/dates', (c: Context) => {
    const targets = listReviewTargets(db, { enabledOnly: true });
    const seen = new Set<string>();
    for (const t of targets) {
      for (const d of listDates(t)) seen.add(d);
    }
    const dates = [...seen].sort().reverse();
    return c.json({ dates });
  });

  // ── public listing API (= レビューカード一覧) ─────────────────────────
  // `?date=YYYY-MM-DD` が付いた場合は 「その日にレビューがあった repo だけ」 を
  // その日の per-date `latest.json` で返す。 無指定なら全体の latest を返す。
  r.get('/api/review/repos', (c: Context) => {
    const targets = listReviewTargets(db, { enabledOnly: true });
    const dateParam = safeDate(c.req.query('date') ?? '');
    const items = targets
      .map((t) => {
        const dates = listDates(t);
        const meta = dateParam ? readDateLatest(t, dateParam) : readLatest(t);
        // dateParam 指定時: その日のディレクトリ自体が無ければ除外。
        const matchesDate = dateParam ? dates.includes(dateParam) : dates.length > 0;
        return {
          repo: t.name,
          target_id: t.id,
          local_path: resolveTargetPath(t),
          format_key: t.format_key,
          has_dates: dates.length > 0,
          matches_date: matchesDate,
          latest_date: meta?.date ?? (dateParam ?? dates[0] ?? null),
          weighted_score: meta?.weighted_score ?? null,
          critical_count: meta?.critical_count ?? 0,
          high_count: meta?.high_count ?? 0,
          fix_pr: meta?.fix_pr ?? null,
        };
      })
      .filter((it) => it.matches_date);
    return c.json({ items, root: LUDIARS_ROOT, date: dateParam ?? null });
  });

  r.get('/api/review/repos/:repo', (c: Context) => {
    const repo = c.req.param('repo') ?? '';
    const target = getReviewTargetByName(db, repo);
    if (!target) return c.json({ error: 'not_found' }, 404);
    const dates = listDates(target);
    const latest = readLatest(target);
    return c.json({ repo: target.name, dates, latest, format_key: target.format_key });
  });

  r.get('/api/review/repos/:repo/:date/:file', (c: Context) => {
    const repo = c.req.param('repo') ?? '';
    const date = safeDate(c.req.param('date') ?? '');
    const file = safeFile(c.req.param('file') ?? '');
    const target = getReviewTargetByName(db, repo);
    if (!target || !date || !file) return c.json({ error: 'invalid path' }, 400);
    const p = join(reviewDir(target), date, file);
    if (!existsSync(p)) return c.json({ error: 'not_found' }, 404);
    const text = readFileSync(p, 'utf8');
    return c.body(text, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  });

  return r;
}
