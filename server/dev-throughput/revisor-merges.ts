// Revisor (審査・マージを持つサービス) からマージ済み PR の一覧を読む adapter。
// 接続先は Excubitor が配る REVISOR_URL。 本文や審査記録は要らないので view=summary で取る。

import type { MergedPullRequest } from './types.js';

export type FetchLike = (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export interface RevisorMergesDeps {
  baseUrl: string | undefined;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export async function fetchMergedPullRequests(deps: RevisorMergesDeps): Promise<MergedPullRequest[]> {
  const base = originOf(deps.baseUrl);
  if (!base) throw new Error('Revisor の接続先 (REVISOR_URL) が設定されていません');
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const response = await fetchImpl(`${base}/v1/local-prs?view=summary&state=merged`, {
    signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
  });
  if (!response.ok) throw new Error(`Revisor が HTTP ${response.status} を返しました`);
  const body: unknown = await response.json();
  const list = isObj(body) && Array.isArray(body.pullRequests) ? body.pullRequests : Array.isArray(body) ? body : null;
  if (!list) throw new Error('Revisor の一覧の形が想定と違います');
  return list.flatMap((item): MergedPullRequest[] => {
    if (!isObj(item) || typeof item.repository !== 'string' || typeof item.updatedAt !== 'string' || typeof item.status !== 'string') return [];
    return [{ repository: item.repository, status: item.status, updatedAt: item.updatedAt }];
  });
}
