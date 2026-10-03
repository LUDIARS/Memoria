/**
 * GitHub 上の本人コミットから月別のコード変更行数を集計し、 Villa 用 HTML / JSON を書き出す。
 *   npm run code-volume -- --months 2025-09,2026-09 --author nyangame --out ../../Villa/code-volume.html
 * token は MEMORIA_GH_TOKEN → GITHUB_TOKEN → `gh auth token` の順に探す。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from '../code-volume/aggregate.js';
import { CommitVolumeCache } from '../code-volume/cache.js';
import { parseCliArgs } from '../code-volume/cli-args.js';
import { collectCommitVolumes } from '../code-volume/collect.js';
import { createGithubCommitClient } from '../code-volume/github-commits.js';
import { renderVolumeHtml } from '../code-volume/render-html.js';

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function resolveToken(): string | null {
  const env = process.env.MEMORIA_GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function writeOut(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2), { cachePath: join(SERVER_DIR, '..', 'data', 'code-volume', 'commits.json') });
  const token = resolveToken();
  if (!token) console.error('[code-volume] token が無いため未認証で呼びます (rate limit が厳しく、 private リポは取れません)');
  const cache = new CommitVolumeCache(opts.cachePath);
  const result = await collectCommitVolumes({
    client: createGithubCommitClient({ token }),
    cache,
    months: opts.months,
    authors: opts.authors,
    excludeRepos: opts.excludeRepo ? (r) => opts.excludeRepo!.test(r) : undefined,
    onProgress: (e) => {
      if (e.kind === 'search') console.error(`[code-volume] search ${e.author} ${e.from}..${e.to}: ${e.hits}`);
      else if (e.done % 25 === 0 || e.done === e.total) console.error(`[code-volume] detail ${e.done}/${e.total}`);
    },
  });
  const report = buildReport({ months: opts.months, commits: result.commits, authors: opts.authors, generatedAt: new Date().toISOString() });
  if (opts.outJson) writeOut(opts.outJson, `${JSON.stringify({ ...report, overflowDays: result.overflowDays }, null, 2)}\n`);
  if (opts.outHtml) writeOut(opts.outHtml, renderVolumeHtml(report, { overflowDays: result.overflowDays }));
  console.error(`[code-volume] commits=${result.searched} fetched=${result.fetched} cached=${result.cached} overflow=${result.overflowDays.length}`);
  for (const m of report.months) {
    console.log(`${m.month}\tcode=${m.codeChanged}\tcodeWeekly=${m.weeklyAvgCodeChanged}\tall=${m.changed}\tallWeekly=${m.weeklyAvgChanged}\tcommits=${m.commits}`);
  }
  console.log(`average\tcodeMonthly=${report.monthlyAvgCodeChanged}\tcodeWeekly=${report.weeklyAvgCodeChanged}\tallMonthly=${report.monthlyAvgChanged}\tallWeekly=${report.weeklyAvgChanged}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
