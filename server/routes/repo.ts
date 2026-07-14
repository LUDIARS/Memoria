// /api/repos/* — ソース管理リポジトリのウォッチ一覧 (`repo_watch` テーブル)。
//
// 目的は 「登録したリポの PR / Issue / デフォルトブランチ最終更新を 1 画面で
// 見渡す」 こと。 内部ビューアは持たず、 フロントの表示はすべて GitHub への
// 外部リンク。 ここで提供するのは:
//   - GET    /api/repos              一覧 (キャッシュ済サマリ込み)
//   - POST   /api/repos              URL / owner/name から追加 + 初回フェッチ
//   - DELETE /api/repos/:id          削除
//   - POST   /api/repos/:id/refresh  1 件だけサマリ取り直し
//   - POST   /api/repos/refresh      全件サマリ取り直し (直列 + 軽い間隔)
//
// GitHub PAT は diary 設定 (`diary_settings.github_token`) を流用する。
// 無くても public repo は取得できる (rate limit は低くなる)。

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  listRepoWatch, getRepoWatch, insertRepoWatch, deleteRepoWatch,
  updateRepoWatchStats, replaceRepoWatchItems, listRepoWatchItems,
  getDiarySettings, type RepoWatchRow, type RepoWatchItemRow,
} from '../db.js';
import { parseRepoInput, fetchRepoStats, fetchRepoRecentCommits, REPO_PROVIDERS } from '../lib/repo-watch.js';

type Db = BetterSqlite3.Database;

export interface RepoRouterDeps { db: Db }

/** diary 設定 or env から GitHub PAT を引く (どちらも無ければ null)。 */
function githubToken(db: Db): string | null {
  const s = getDiarySettings(db);
  return s.github_token || process.env.MEMORIA_GH_TOKEN || null;
}

/** 1 件フェッチ → repo_watch のキャッシュ列を更新 → items も差し替え → 最新行を返す。 */
async function refreshOne(db: Db, row: RepoWatchRow): Promise<RepoWatchRow> {
  const stats = await fetchRepoStats(row, githubToken(db));
  updateRepoWatchStats(db, row.id, {
    default_branch:      stats.default_branch,
    open_pr_count:       stats.open_pr_count,
    open_issue_count:    stats.open_issue_count,
    last_commit_sha:     stats.last_commit_sha,
    last_commit_message: stats.last_commit_message,
    last_commit_url:     stats.last_commit_url,
    last_commit_at:      stats.last_commit_at,
    ci_status:           stats.ci.status,
    ci_conclusion:       stats.ci.conclusion,
    ci_url:              stats.ci.url,
    ci_workflow_name:    stats.ci.workflow_name,
    ci_run_at:           stats.ci.run_at,
    fetch_error:         stats.fetch_error,
  });
  replaceRepoWatchItems(db, row.id, stats.items);
  return getRepoWatch(db, row.id) ?? row;
}

/** カード表示用に row + top N items を組み立てる。 */
function rowWithItems(db: Db, row: RepoWatchRow, topN: number) {
  return { ...row, items: listRepoWatchItems(db, row.id, topN) };
}

export function makeRepoRouter(deps: RepoRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  // ── 一覧 ────────────────────────────────────────────────────────────────
  // 各 repo に top 5 の PR/Issue items を同梱して返す。 50 件まで展開する場合は
  // /api/repos/:id/items を別途叩く。
  r.get('/api/repos', (c: Context) => {
    return c.json({
      items: listRepoWatch(db).map((row) => rowWithItems(db, row, 5)),
      providers: REPO_PROVIDERS,
      token_set: !!githubToken(db),
    });
  });

  // ── 1 リポの items 拡張 (more ボタン押下時に最大 50 件取得) ───────────────
  r.get('/api/repos/:id/items', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    if (!getRepoWatch(db, id)) return c.json({ error: 'not_found' }, 404);
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit')) || 50));
    const items: RepoWatchItemRow[] = listRepoWatchItems(db, id, limit);
    return c.json({ items });
  });

  // ── 1 リポの直近コミット (= カードを 「開いた」 時に出す「直近の作業」 サマリ) ─
  // キャッシュ列を増やさず lazy fetch のみ。 失敗時は items=[] + error を返す。
  r.get('/api/repos/:id/commits', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const row = getRepoWatch(db, id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const limit = Math.min(30, Math.max(1, Number(c.req.query('limit')) || 10));
    const r2 = await fetchRepoRecentCommits(row, githubToken(db), limit);
    return c.json(r2);
  });

  // ── 追加 ────────────────────────────────────────────────────────────────
  // body: { url: string }  — URL でも owner/name でも可。 追加直後に 1 回
  // フェッチして初期サマリを埋める (フェッチ失敗でも登録自体は成功扱い)。
  r.post('/api/repos', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { url?: unknown } | null;
    const raw = typeof body?.url === 'string' ? body.url : '';
    const parsed = parseRepoInput(raw);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);

    let id: number;
    try {
      id = insertRepoWatch(db, {
        provider: parsed.provider,
        owner: parsed.owner,
        name: parsed.name,
        html_url: parsed.html_url,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/UNIQUE/i.test(msg)) {
        return c.json({ error: `登録済みです: ${parsed.owner}/${parsed.name}` }, 409);
      }
      return c.json({ error: `登録に失敗しました: ${msg}` }, 500);
    }

    const inserted = getRepoWatch(db, id);
    if (!inserted) return c.json({ error: 'insert succeeded but row not found' }, 500);
    const row = await refreshOne(db, inserted);
    return c.json({ item: rowWithItems(db, row, 5) }, 201);
  });

  // ── 削除 ────────────────────────────────────────────────────────────────
  r.delete('/api/repos/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    return c.json({ ok: deleteRepoWatch(db, id) });
  });

  // ── 1 件サマリ更新 ──────────────────────────────────────────────────────
  r.post('/api/repos/:id/refresh', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const row = getRepoWatch(db, id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const refreshed = await refreshOne(db, row);
    return c.json({ item: rowWithItems(db, refreshed, 5) });
  });

  // ── 全件サマリ更新 ──────────────────────────────────────────────────────
  // GitHub API のレート制限を踏まないよう直列 + 200ms 間隔。 件数が多い時は
  // 数秒かかるが、 手動操作前提なので許容する。
  r.post('/api/repos/refresh', async (c: Context) => {
    const rows = listRepoWatch(db);
    for (const row of rows) {
      await refreshOne(db, row);
      await new Promise((res) => setTimeout(res, 200));
    }
    return c.json({
      items: listRepoWatch(db).map((row) => rowWithItems(db, row, 5)),
    });
  });

  return r;
}
