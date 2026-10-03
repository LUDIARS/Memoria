import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildReport, codeLines, summarizeMonth } from './aggregate.js';
import { CommitVolumeCache } from './cache.js';
import { parseCliArgs } from './cli-args.js';
import { collectCommitVolumes } from './collect.js';
import { isCodeFile } from './file-filter.js';
import { createGithubCommitClient, type Fetch } from './github-commits.js';
import { daysInMonth, monthOf, searchWindows, splitWindowByDay } from './period.js';
import { renderVolumeHtml } from './render-html.js';
import type { CommitVolume } from './types.js';

/** codeAdditions / codeDeletions はコードファイル 1 本の変更として files に入れる */
function commit(p: Partial<CommitVolume> & { sha: string; authoredAt: string; codeAdditions?: number; codeDeletions?: number }): CommitVolume {
  const { codeAdditions = 0, codeDeletions = 0, ...rest } = p;
  const files = codeAdditions || codeDeletions ? [{ path: 'src/a.ts', additions: codeAdditions, deletions: codeDeletions }] : [];
  return { repo: 'o/r', additions: 0, deletions: 0, files, filesTruncated: false, ...rest };
}

test('月の日数と JST での月判定', () => {
  assert.equal(daysInMonth('2024-02'), 29);
  assert.equal(daysInMonth('2026-09'), 30);
  assert.equal(monthOf('2026-08-31T15:30:00Z'), '2026-09');
  assert.equal(monthOf('2026-08-31T14:59:59Z'), '2026-08');
  assert.throws(() => daysInMonth('2026-13'));
});

test('検索窓は前後 1 日を含めて月全体を隙間なく覆う', () => {
  const ws = searchWindows('2026-09');
  assert.equal(ws[0].from, '2026-08-31');
  assert.equal(ws.at(-1)!.to, '2026-10-01');
  for (let i = 1; i < ws.length; i++) {
    assert.equal(Date.parse(ws[i].from) - Date.parse(ws[i - 1].to), 86_400_000);
  }
  assert.deepEqual(splitWindowByDay({ from: '2026-09-01', to: '2026-09-03' }).map((w) => w.from), ['2026-09-01', '2026-09-02', '2026-09-03']);
});

test('コードファイル判定は生成物・同梱ライブラリ・ロックを外す', () => {
  assert.equal(isCodeFile('server/index.ts'), true);
  assert.equal(isCodeFile('Assets/Scripts/Player.cs'), true);
  assert.equal(isCodeFile('package-lock.json'), false);
  assert.equal(isCodeFile('engine/third_party/stb/stb_image.h'), false);
  assert.equal(isCodeFile('web/dist/app.js'), false);
  assert.equal(isCodeFile('public/vendor.min.js'), false);
  assert.equal(isCodeFile('spec/data/map.json'), false);
  assert.equal(isCodeFile('report/stages/05-anatomia-analysis.html'), false);
  assert.equal(isCodeFile('artifacts/demo/sdk/include/GLFW/glfw3.h'), false);
});

test('コード行は集計時にファイル内訳から数える', () => {
  const c = commit({ sha: 'x', authoredAt: '2026-09-01T00:00:00Z', additions: 40, deletions: 6, files: [
    { path: 'src/a.ts', additions: 10, deletions: 2 },
    { path: 'report/out.html', additions: 30, deletions: 0 },
    { path: 'src/b.cs', additions: 0, deletions: 4 },
  ] });
  assert.deepEqual(codeLines(c), { additions: 10, deletions: 6 });
});

test('月集計は対象月だけを数え、 sha の重複を 1 回にし、 週平均を日数で割る', () => {
  const cs = [
    commit({ sha: 'a', authoredAt: '2026-09-02T00:00:00Z', repo: 'o/x', additions: 100, deletions: 40, codeAdditions: 60, codeDeletions: 10 }),
    commit({ sha: 'a', authoredAt: '2026-09-02T00:00:00Z', repo: 'o/x', additions: 100, deletions: 40, codeAdditions: 60, codeDeletions: 10 }),
    commit({ sha: 'b', authoredAt: '2026-09-20T00:00:00Z', repo: 'o/y', additions: 50, deletions: 0, codeAdditions: 50, codeDeletions: 0, filesTruncated: true }),
    commit({ sha: 'c', authoredAt: '2026-10-01T00:00:00Z', additions: 999 }),
  ];
  const m = summarizeMonth('2026-09', cs);
  assert.equal(m.commits, 2);
  assert.equal(m.repos, 2);
  assert.equal(m.changed, 190);
  assert.equal(m.codeChanged, 120);
  assert.equal(m.weeklyAvgCodeChanged, 28);
  assert.equal(m.truncatedCommits, 1);
  assert.deepEqual(m.topRepos.map((r) => r.repo), ['o/x', 'o/y']);
});

test('全体の月平均と週平均は選んだ月で割る (空の月も 0 として含む)', () => {
  const r = buildReport({
    months: ['2026-09', '2024-02'],
    commits: [commit({ sha: 'a', authoredAt: '2026-09-02T00:00:00Z', codeAdditions: 590, additions: 590 })],
    authors: [{ kind: 'login', value: 'me' }],
    generatedAt: 'now',
  });
  assert.deepEqual(r.months.map((m) => m.month), ['2024-02', '2026-09']);
  assert.equal(r.monthlyAvgCodeChanged, 295);
  assert.equal(r.weeklyAvgCodeChanged, 70); // 590 / (59 / 7)
});

test('CLI 引数: 月の形式と本人識別子を必須にする', () => {
  const o = parseCliArgs(['--months', '2024-02, 2026-09', '--author', 'me', '--author-email', 'bot@x'], { cachePath: 'c.json' });
  assert.deepEqual(o.months, ['2024-02', '2026-09']);
  assert.deepEqual(o.authors, [{ kind: 'login', value: 'me' }, { kind: 'email', value: 'bot@x' }]);
  assert.throws(() => parseCliArgs(['--months', '2024-2', '--author', 'me'], { cachePath: 'c' }));
  assert.throws(() => parseCliArgs(['--months', '2024-02'], { cachePath: 'c' }));
  assert.throws(() => parseCliArgs(['--author'], { cachePath: 'c' }));
});

function fakeFetch(routes: (url: string) => { status: number; body?: unknown; headers?: Record<string, string> }): { fetch: Fetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      const r = routes(url);
      return { status: r.status, headers: { get: (k) => r.headers?.[k.toLowerCase()] ?? null }, json: async () => r.body };
    },
  };
}

test('GitHub adapter: rate limit は reset まで待って再試行し、 ファイル単位でコード行を数える', async () => {
  let first = true;
  const waits: number[] = [];
  const { fetch } = fakeFetch((url) => {
    if (first) { first = false; return { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '110' } }; }
    assert.match(url, /\/repos\/o\/r\/commits\/s1/);
    return { status: 200, body: {
      commit: { author: { date: '2026-09-01T00:00:00Z' } },
      stats: { additions: 30, deletions: 5 },
      files: [{ filename: 'a.ts', additions: 20, deletions: 5 }, { filename: 'package-lock.json', additions: 10, deletions: 0 }],
    } };
  });
  const client = createGithubCommitClient({ token: 't', fetch, sleep: async (ms) => { waits.push(ms); }, now: () => 100_000 });
  const v = await client.fetchCommitVolume({ sha: 's1', repo: 'o/r' });
  assert.deepEqual(waits, [11_000]);
  assert.equal(v.additions, 30);
  assert.equal(v.files.length, 2);
  assert.deepEqual(codeLines(v), { additions: 20, deletions: 5 });
});

test('collect: 1000 件超の窓は日単位に割り、 キャッシュ済みは詳細を取らない', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'code-volume-'));
  try {
    const cache = new CommitVolumeCache(join(dir, 'c.json'));
    cache.put(commit({ sha: 'cached', authoredAt: '2026-09-03T00:00:00Z', additions: 7 }));
    const { fetch, urls } = fakeFetch((url) => {
      if (url.includes('/search/commits')) {
        const q = decodeURIComponent(new URL(url).searchParams.get('q')!);
        if (q.includes('2026-08-31..2026-09-06')) return { status: 200, body: { total_count: 1500, items: [] } };
        if (q.includes('2026-09-02..2026-09-02')) {
          return { status: 200, body: { total_count: 2, items: [
            { sha: 'new', repository: { full_name: 'o/r' } }, { sha: 'cached', repository: { full_name: 'o/r' } },
          ] } };
        }
        return { status: 200, body: { total_count: 0, items: [] } };
      }
      return { status: 200, body: { commit: { author: { date: '2026-09-02T00:00:00Z' } }, stats: { additions: 3, deletions: 1 }, files: [] } };
    });
    const res = await collectCommitVolumes({
      client: createGithubCommitClient({ token: null, fetch, sleep: async () => {} }),
      cache, months: ['2026-09'], authors: [{ kind: 'login', value: 'me' }],
    });
    assert.equal(res.searched, 2);
    assert.equal(res.fetched, 1);
    assert.equal(urls.filter((u) => u.includes('/commits/')).length, 1);
    assert.deepEqual(res.commits.map((c) => c.sha).sort(), ['cached', 'new']);
    assert.equal(new CommitVolumeCache(join(dir, 'c.json')).has('new'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTML はリポ名をエスケープし、 平均値を載せる', () => {
  const r = buildReport({
    months: ['2026-09'],
    commits: [commit({ sha: 'a', authoredAt: '2026-09-02T00:00:00Z', repo: 'o/<x>', codeAdditions: 30 })],
    authors: [{ kind: 'login', value: 'me' }],
    generatedAt: '2026-10-03T00:00:00Z',
  });
  const html = renderVolumeHtml(r);
  assert.match(html, /o\/&lt;x&gt;/);
  assert.doesNotMatch(html, /o\/<x>/);
  assert.match(html, /<title>コード変更量<\/title>/);
  assert.match(html, /週平均 \(コード\)/);
});

test('HTML は非公開リポの名前を伏せてまとめる', () => {
  const r = buildReport({
    months: ['2026-09'],
    commits: [
      commit({ sha: 'a', authoredAt: '2026-09-02T00:00:00Z', repo: 'pub/open', codeAdditions: 10 }),
      commit({ sha: 'b', authoredAt: '2026-09-03T00:00:00Z', repo: 'org/secret-one', codeAdditions: 20 }),
      commit({ sha: 'c', authoredAt: '2026-09-04T00:00:00Z', repo: 'org/secret-two', codeAdditions: 5 }),
    ],
    authors: [{ kind: 'login', value: 'me' }],
    generatedAt: 'now',
  });
  const html = renderVolumeHtml(r, { privateRepos: new Set(['org/secret-one', 'org/secret-two']) });
  assert.match(html, /pub\/open/);
  assert.doesNotMatch(html, /secret-one|secret-two/);
  assert.match(html, /非公開リポ \(2 件\) <span class="muted">25<\/span>/);
});

test('GitHub adapter: 見えないリポは非公開として扱う', async () => {
  const { fetch } = fakeFetch((url) => (url.endsWith('/repos/o/pub')
    ? { status: 200, body: { private: false } }
    : { status: 404 }));
  const client = createGithubCommitClient({ token: null, fetch, sleep: async () => {} });
  assert.equal(await client.isPrivateRepo('o/pub'), false);
  assert.equal(await client.isPrivateRepo('o/hidden'), true);
});
