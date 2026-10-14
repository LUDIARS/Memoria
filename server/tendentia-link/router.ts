// Memoria から Tendentia (トレンドの集積サービス) への接続口。 Memoria のサーバが同じ端末の Tendentia API を読み、
// 画面には要点 (ジャンルごとの注目・複数サイトで話題) と、 Tendentia の画面を開く URL だけを返す。
//
// 接続先は Excubitor が配る TENDENTIA_URL (Tendentia の catalog の provides)、 画面を開く URL は
// TENDENTIA_PUBLIC_URL があればそれ (外から開ける公開 URL)、 無ければ TENDENTIA_URL。

import { Hono, type Context } from 'hono';
import { isSameMachineRequest } from '../lib/local-request.js';
import { summarizeOverview, type TendentiaSummary } from './summary.js';

export type TendentiaFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface TendentiaLinkDeps {
  baseUrl?: string;
  publicUrl?: string;
  fetchImpl?: TendentiaFetch;
  timeoutMs?: number;
}

export type TendentiaLinkResponse =
  | { available: true; openUrl: string; summary: TendentiaSummary }
  | { available: false; openUrl: string | null; reason: string };

function normalizedBase(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export async function loadTendentiaLink(deps: TendentiaLinkDeps): Promise<TendentiaLinkResponse> {
  const base = normalizedBase(deps.baseUrl);
  const openUrl = normalizedBase(deps.publicUrl) ?? base;
  if (!base) return { available: false, openUrl, reason: 'Tendentia の接続先 (TENDENTIA_URL) が設定されていません' };
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  try {
    const response = await fetchImpl(`${base}/api/trend-crawler/overview`, { signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) });
    if (!response.ok) return { available: false, openUrl, reason: `Tendentia が HTTP ${response.status} を返しました` };
    const body = await response.json() as { overview?: unknown };
    return { available: true, openUrl: openUrl ?? base, summary: summarizeOverview(body.overview) };
  } catch (error: unknown) {
    return { available: false, openUrl, reason: `Tendentia に接続できません (${error instanceof Error ? error.message : String(error)})` };
  }
}

export function makeTendentiaLinkRouter(deps: TendentiaLinkDeps = {}): Hono {
  const router = new Hono();
  router.use('/api/tendentia/*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    if (!isSameMachineRequest(context)) return context.json({ error: 'same-machine access required' }, 403);
    await next();
  });
  router.get('/api/tendentia/summary', async (context: Context) => context.json(await loadTendentiaLink({
    baseUrl: deps.baseUrl ?? process.env.TENDENTIA_URL,
    publicUrl: deps.publicUrl ?? process.env.TENDENTIA_PUBLIC_URL,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  })));
  return router;
}
