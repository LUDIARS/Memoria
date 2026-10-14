// ジャンル別の「今の流行」を AI でまとめる。 1 回の巡回につき LLM 呼び出しは 1 回 (全ジャンルを 1 つの JSON で返させる)。

import { runLlm } from '../llm.js';
import { TREND_GENRES, type TrendGenre, type TrendGenreView, type TrendSummary } from './types.js';

const ITEMS_PER_SOURCE_IN_PROMPT = 10;
const MAX_TEXT_CHARS = 600;

export type TrendSummaryRunner = (prompt: string) => Promise<string>;

const defaultRunner: TrendSummaryRunner = (prompt) => runLlm({ task: 'trend_summarize', prompt });

function movementNote(status: string, delta: number | null): string {
  if (status === 'new') return ' [新登場]';
  if (status === 'up' && delta !== null && delta >= 5) return ` [↑${delta}]`;
  return '';
}

export function buildTrendSummaryPrompt(genres: TrendGenreView[]): string {
  const blocks = genres.map((genre) => {
    const lines = genre.sources.flatMap((source) => source.items.slice(0, ITEMS_PER_SOURCE_IN_PROMPT).map((item) =>
      `- (${source.name} ${item.rank}位) ${item.title}${item.subtitle ? ` / ${item.subtitle}` : ''}${item.metric ? ` (${item.metric})` : ''}${movementNote(item.movement.status, item.movement.delta)}`));
    return [`## ${genre.genre} (${genre.label})`, ...(lines.length ? lines : ['- (データなし)'])].join('\n');
  });
  const keys = genres.map((genre) => `"${genre.genre}"`).join(', ');
  return [
    '以下は各ジャンルのランキング・人気一覧の上位です。 ジャンルごとに「いま何が流行っているか」を日本語でまとめてください。',
    '各ジャンルは 2〜3 文、 合計 120 文字以内。 個々の項目を並べ直すのではなく、 共通する話題・急上昇・新登場から傾向を書く。',
    'データが無い・傾向が読み取れないジャンルは "目立った動きなし" とする。 推測で事実を足さない。',
    `出力は JSON オブジェクト 1 つだけ。 キーは "overall" (全体の流れを 2〜3 文) と ${keys}。 前置き・コードフェンス不要。`,
    '',
    ...blocks,
  ].join('\n');
}

/** LLM 出力 (コードフェンス・前置き付き) から最初の JSON オブジェクトを取り出す。 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

export function parseTrendSummary(raw: string, now: Date): TrendSummary {
  const object = extractJsonObject(raw);
  if (!object) throw new Error('AI の要約が JSON として読めませんでした');
  const genres: Partial<Record<TrendGenre, string>> = {};
  for (const genre of TREND_GENRES) {
    const text = cleanText(object[genre]);
    if (text) genres[genre] = text;
  }
  return { generatedAt: now.toISOString(), overall: cleanText(object.overall), genres };
}

export async function summarizeTrends(
  genres: TrendGenreView[],
  now: Date,
  run: TrendSummaryRunner = defaultRunner,
): Promise<TrendSummary> {
  const withData = genres.filter((genre) => genre.sources.some((source) => source.items.length > 0));
  if (withData.length === 0) throw new Error('要約できるトレンドがまだありません');
  return parseTrendSummary(await run(buildTrendSummaryPrompt(withData)), now);
}
