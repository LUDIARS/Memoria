/**
 * 収集の use case: 月 × 本人識別子ごとにコミットを検索し、 キャッシュに無いものだけ詳細を取る。
 */
import type { CommitVolumeCache } from './cache.js';
import { SearchOverflowError, type GithubCommitClient, type SearchHit } from './github-commits.js';
import { searchWindows, splitWindowByDay } from './period.js';
import type { AuthorIdentity, CommitVolume } from './types.js';

export interface CollectProgress {
  (event: { kind: 'search'; author: string; from: string; to: string; hits: number }
    | { kind: 'detail'; done: number; total: number }): void;
}

export interface CollectResult {
  /** 今回の検索に当たったコミット (キャッシュ由来を含む)。 集計はこれだけを使う */
  commits: CommitVolume[];
  searched: number;
  fetched: number;
  cached: number;
  /** 1 日に絞っても 1000 件を超え、 取りこぼしがある窓 */
  overflowDays: string[];
}

async function searchWindow(
  client: GithubCommitClient,
  author: AuthorIdentity,
  w: { from: string; to: string },
  overflowDays: string[],
  onProgress?: CollectProgress,
): Promise<SearchHit[]> {
  try {
    const hits = await client.searchCommits(author, w.from, w.to);
    onProgress?.({ kind: 'search', author: author.value, from: w.from, to: w.to, hits: hits.length });
    return hits;
  } catch (e) {
    if (!(e instanceof SearchOverflowError)) throw e;
    if (w.from === w.to) {
      overflowDays.push(`${author.value}:${w.from}`);
      return [];
    }
    const out: SearchHit[] = [];
    for (const d of splitWindowByDay(w)) out.push(...await searchWindow(client, author, d, overflowDays, onProgress));
    return out;
  }
}

export async function collectCommitVolumes(input: {
  client: GithubCommitClient;
  cache: CommitVolumeCache;
  months: string[];
  authors: AuthorIdentity[];
  excludeRepos?: (repo: string) => boolean;
  onProgress?: CollectProgress;
  /** 詳細取得 N 件ごとにキャッシュを保存する */
  saveEvery?: number;
}): Promise<CollectResult> {
  const { client, cache, onProgress } = input;
  const overflowDays: string[] = [];
  const hits = new Map<string, SearchHit>();
  for (const month of input.months) {
    for (const author of input.authors) {
      for (const w of searchWindows(month)) {
        for (const h of await searchWindow(client, author, w, overflowDays, onProgress)) {
          if (!input.excludeRepos?.(h.repo)) hits.set(h.sha, h);
        }
      }
    }
  }
  const todo = [...hits.values()].filter((h) => !cache.has(h.sha));
  const saveEvery = input.saveEvery ?? 50;
  let done = 0;
  for (const h of todo) {
    cache.put(await client.fetchCommitVolume(h));
    done += 1;
    onProgress?.({ kind: 'detail', done, total: todo.length });
    if (done % saveEvery === 0) cache.save();
  }
  cache.save();
  const commits = [...hits.keys()].map((sha) => cache.get(sha)).filter((c): c is CommitVolume => !!c);
  return { commits, searched: hits.size, fetched: todo.length, cached: hits.size - todo.length, overflowDays };
}
