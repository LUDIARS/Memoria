// /api/review/* — レビュー対象 (`review_targets` テーブル) と、 集約された
// レビュー記録 `Review/<repo>/<YYYY-MM-DD>/` 配下のファイルを返す API。
//
// データソース:
//   - SQLite テーブル `review_targets` で 「どのリポを対象に listing するか」 を管理
//   - レビュー記録は各サービスリポ配下ではなく、 ワークスペース直下の集約フォルダ
//     `LUDIARS_ROOT/Review/<repo>/` に置く (Castra が git 管理。 各リポの
//     worktree cleanup / branch 切替 / gitignore で消えないよう切り離した)。
//   - <repo> はターゲットのローカルクローンのディレクトリ名 (= basename)。
//
// 起動時に `LUDIARS_ROOT` (= E:/Document/Ars) を走査して LUDIARS clone を
// 自動 seed する (init.ts から `seedReviewTargets` を呼ぶ)。

import { Hono, type Context } from 'hono';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, isAbsolute, basename } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import {
  listReviewTargets, getReviewTargetByName, insertReviewTarget,
  insertReviewTargetIfMissing, updateReviewTarget, deleteReviewTarget,
  type ReviewTargetRow,
} from '../db.js';

type Db = BetterSqlite3.Database;

const LUDIARS_ROOT = resolve(process.env.LUDIARS_ROOT ?? 'E:/Document/Ars');
/** 集約レビュー記録のルート (Castra が git 管理する Ars 直下の Review/)。 */
const REVIEW_ROOT = join(LUDIARS_ROOT, 'Review');
const SUPPORTED_FORMATS = new Set(['aiformat', 'foedus']);

// レビュー形式ごとに表示/配信を許可するファイル集合。
//   aiformat = ludiars-review (設計/脆弱性/実装/不足/品質 + 総合)
//   foedus   = Cernere↔Hub 連結契約レビュー (層B Foedus + 層C 観点)
const REVIEW_FILES_BY_FORMAT: Record<string, readonly string[]> = {
  aiformat: [
    'REVIEW.md',
    'REVIEW_DESIGN.md',
    'REVIEW_VULNERABILITY.md',
    'REVIEW_IMPLEMENTATION.md',
    'REVIEW_MISSING_FEATURES.md',
    'REVIEW_QUALITY.md',
  ],
  foedus: [
    'REVIEW.md',
    'REVIEW_DATA_BOUNDARY.md',
    'REVIEW_LINKAGE_CONTRACT.md',
    'REVIEW_SECURITY.md',
    'REVIEW_FLOW.md',
    'CONTRACT.md',
  ],
};
/** 全形式を合算した許可集合 (format 不明時のフォールバック判定用)。 */
const ALL_REVIEW_FILES = new Set<string>(Object.values(REVIEW_FILES_BY_FORMAT).flat());

function reviewFilesFor(format: string): readonly string[] {
  return REVIEW_FILES_BY_FORMAT[format] ?? REVIEW_FILES_BY_FORMAT.aiformat;
}

function safeDate(s: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** ファイル名がレビュー成果物として許可されているか。 format 指定時はその形式の
 *  集合に限定し、 未指定なら全形式合算で判定する。 */
function safeFile(name: string, format?: string): string | null {
  if (format) return reviewFilesFor(format).includes(name) ? name : null;
  return ALL_REVIEW_FILES.has(name) ? name : null;
}

/** 正規化済みの latest メタ (形式差を吸収してカード表示に使う)。 */
interface NormalizedLatest {
  date: string | null;
  weighted_score: string | null;
  grade: string | null;
  critical_count: number;
  high_count: number;
  fix_pr: string | null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 形式別の latest.json を共通のカード表示メタに正規化する。
 *  - aiformat: weighted_score / critical_count / high_count をそのまま使う
 *  - foedus:   grade を score 欄に流用し、 contract.by_severity から件数を引く */
function normalizeLatest(raw: Record<string, unknown> | null, format: string): NormalizedLatest {
  const empty: NormalizedLatest = {
    date: null, weighted_score: null, grade: null,
    critical_count: 0, high_count: 0, fix_pr: null,
  };
  if (!raw) return empty;
  const date = asString(raw.date);
  const fix_pr = asString(raw.fix_pr);
  if (format === 'foedus') {
    const grade = asString(raw.grade);
    const contract = (raw.contract && typeof raw.contract === 'object')
      ? raw.contract as Record<string, unknown> : {};
    const bySev = (contract.by_severity && typeof contract.by_severity === 'object')
      ? contract.by_severity as Record<string, unknown> : {};
    return {
      date, grade,
      weighted_score: grade,
      critical_count: asCount(bySev.critical),
      high_count: asCount(bySev.high),
      fix_pr,
    };
  }
  const weighted = asString(raw.weighted_score);
  return {
    date,
    weighted_score: weighted,
    grade: weighted,
    critical_count: asCount(raw.critical_count),
    high_count: asCount(raw.high_count),
    fix_pr,
  };
}

/** ターゲットの local_path を絶対パスに解決 (= 相対なら LUDIARS_ROOT 起点)。 */
function resolveTargetPath(target: ReviewTargetRow): string {
  return isAbsolute(target.local_path) ? target.local_path : resolve(LUDIARS_ROOT, target.local_path);
}

/** 集約 Review/<repo>/ のパス。 <repo> はクローンディレクトリ名 (= basename)。 */
function reviewDir(target: ReviewTargetRow): string {
  return join(REVIEW_ROOT, basename(resolveTargetPath(target)));
}

function readLatest(target: ReviewTargetRow): Record<string, unknown> | null {
  const top = join(reviewDir(target), 'latest.json');
  if (existsSync(top)) {
    try { return JSON.parse(readFileSync(top, 'utf8')) as Record<string, unknown>; } catch { /* fall through */ }
  }
  // 集約トップに latest.json を持たない形式 (= cernere-hub-review/foedus は
  // 日付ディレクトリ配下にしか出さない) は、 最新日付の latest.json を採用する。
  for (const d of listDates(target)) {
    const p = join(reviewDir(target), d, 'latest.json');
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { /* try older */ }
    }
  }
  return null;
}

/** 指定日付の `review/<date>/latest.json` を読む。 無ければ null。 */
function readDateLatest(target: ReviewTargetRow, date: string): Record<string, unknown> | null {
  const p = join(reviewDir(target), date, 'latest.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

function listDates(target: ReviewTargetRow): string[] {
  const dir = reviewDir(target);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => safeDate(n) && statSync(join(dir, n)).isDirectory())
    .filter((d) => hasReviewFile(join(dir, d)))
    .sort()
    .reverse();
}

/**
 * 日付ディレクトリ内に「実体としてのレビュー成果物」 (= REVIEW*.md) が
 * 1 本でも存在するか。 autofix step (= AUTOFIX.md) だけで review step が
 * 失敗 / スキップされた日のディレクトリを除外するため。
 *
 * 期待される命名: REVIEW.md, REVIEW_DESIGN.md, REVIEW_VULNERABILITY.md, ...
 */
function hasReviewFile(dateDir: string): boolean {
  try {
    return readdirSync(dateDir).some((f) => /^REVIEW(_[A-Z_]+)?\.md$/.test(f));
  } catch {
    return false;
  }
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

/** 日付ディレクトリのどれかに Foedus マーカー (`CONTRACT.md` か `violations.json`)
 *  があれば foedus 形式のレビュースコープとみなす。 */
function isFoedusScope(dir: string): boolean {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return false; }
  for (const d of entries) {
    if (!safeDate(d)) continue;
    const dd = join(dir, d);
    try { if (!statSync(dd).isDirectory()) continue; } catch { continue; }
    if (existsSync(join(dd, 'CONTRACT.md')) || existsSync(join(dd, 'violations.json'))) return true;
  }
  return false;
}

/** 起動時に集約 `Review/` 直下を走査し、 git clone ではない「仮想レビュースコープ」
 *  (= Foedus の Cernere↔Hub 連結契約レビュー等) を review_targets に登録する。
 *  日付ディレクトリ内に CONTRACT.md / violations.json を持つものを foedus 形式とし、
 *  basename がそのまま reviewDir (`Review/<name>`) に解決される。 既存はスキップ。 */
export function seedReviewScopes(db: Db): { seeded: number; skipped: number } {
  if (!existsSync(REVIEW_ROOT)) return { seeded: 0, skipped: 0 };
  let seeded = 0;
  let skipped = 0;
  for (const name of readdirSync(REVIEW_ROOT).sort()) {
    const dir = join(REVIEW_ROOT, name);
    let stat;
    try { stat = statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    if (!isFoedusScope(dir)) continue;
    const inserted = insertReviewTargetIfMissing(db, {
      name,
      local_path: dir,
      format_key: 'foedus',
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
        const raw = dateParam ? readDateLatest(t, dateParam) : readLatest(t);
        const meta = normalizeLatest(raw, t.format_key);
        // dateParam 指定時: その日のディレクトリ自体が無ければ除外。
        const matchesDate = dateParam ? dates.includes(dateParam) : dates.length > 0;
        return {
          repo: t.name,
          target_id: t.id,
          local_path: resolveTargetPath(t),
          format_key: t.format_key,
          has_dates: dates.length > 0,
          matches_date: matchesDate,
          latest_date: meta.date ?? (dateParam ?? dates[0] ?? null),
          weighted_score: meta.weighted_score,
          grade: meta.grade,
          critical_count: meta.critical_count,
          high_count: meta.high_count,
          fix_pr: meta.fix_pr,
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
    const target = getReviewTargetByName(db, repo);
    const date = safeDate(c.req.param('date') ?? '');
    const file = target ? safeFile(c.req.param('file') ?? '', target.format_key) : null;
    if (!target || !date || !file) return c.json({ error: 'invalid path' }, 400);
    const p = join(reviewDir(target), date, file);
    if (!existsSync(p)) return c.json({ error: 'not_found' }, 404);
    const text = readFileSync(p, 'utf8');
    return c.body(text, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  });

  return r;
}
