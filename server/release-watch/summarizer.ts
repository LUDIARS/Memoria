import { runLlm } from '../llm.js';
import type { RawRelease, ReleaseEntry, ReleaseSource } from './types.js';

const MAX_SUMMARY_CHARS = 1_500;
const EMPTY_BODY_NOTE = '（公式の変更点本文が取得できなかったため要約なし。 リンク先を参照）';

export function buildSummaryPrompt(source: ReleaseSource, release: RawRelease): string {
  return [
    `「${source.name}」のバージョン ${release.version} の更新履歴を日本語で簡潔にまとめてください。`,
    '出力は Markdown の箇条書き 3〜6 行のみ。 各行は 60 文字以内、 重要な新機能・破壊的変更・修正を優先し、 些末な内部変更は省く。',
    '前置き・見出し・原文引用・英語のままの列挙は不要。 本文が空や意味不明なら「変更点の記載なし」と 1 行だけ返す。',
    '',
    '--- 原文 ---',
    release.body.trim() || '(empty)',
  ].join('\n');
}

export function sanitizeSummary(raw: string): string {
  const text = raw.replace(/```[a-z]*\n?/gi, '').trim();
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}…` : text;
}

export type SummaryRunner = (prompt: string) => Promise<string>;

const defaultRunner: SummaryRunner = (prompt) => runLlm({ task: 'release_summarize', prompt });

export async function summarizeRelease(
  source: ReleaseSource,
  release: RawRelease,
  now: Date,
  run: SummaryRunner = defaultRunner,
): Promise<ReleaseEntry> {
  let summaryJa: string;
  if (!release.body.trim()) {
    summaryJa = EMPTY_BODY_NOTE;
  } else {
    const raw = await run(buildSummaryPrompt(source, release));
    summaryJa = sanitizeSummary(raw) || EMPTY_BODY_NOTE;
  }
  return {
    version: release.version,
    url: release.url,
    publishedAt: release.publishedAt,
    summaryJa,
    summarizedAt: now.toISOString(),
  };
}
