// LLM 推薦のプロンプト組み立てと出力パース。 ネットワークも DB も触らない
// (テストしやすいように suggest.ts の I/O から切り離す)。

import { extractJsonArray } from '../release-watch/llm-json.js';
import type { Book } from './types.js';

/** LLM が返す 1 件。 実在確認は呼び出し側が書誌 API で行う。 */
export interface LlmBookProposal {
  title: string;
  author: string;
  reason: string;
}

const MAX_PROFILE_BOOKS = 40;

/** 良かった本 → プロファイル行。 感想は長いので頭だけ渡す。 */
function profileLine(book: Book): string {
  const authors = book.authors.length > 0 ? book.authors.join(', ') : '著者不明';
  const stars = book.rating ? `★${book.rating}` : '未評価';
  const tags = book.tags.length > 0 ? ` [${book.tags.join('/')}]` : '';
  const review = book.review ? ` — ${book.review.replace(/\s+/g, ' ').slice(0, 80)}` : '';
  return `- ${book.title} / ${authors} (${stars})${tags}${review}`;
}

export function buildSuggestPrompt(favorites: Book[], readOnly: Book[], count: number): string {
  const liked = favorites.slice(0, MAX_PROFILE_BOOKS).map(profileLine).join('\n');
  const alreadyRead = readOnly.slice(0, MAX_PROFILE_BOOKS)
    .map((b) => `- ${b.title}`).join('\n');
  return [
    'あなたは読書傾向から本を薦める司書です。 次の 「良かった本」 の傾向を読み取り、',
    `まだ読んでいない本を ${count} 冊提案してください。`,
    '',
    '## 良かった本',
    liked || '(まだ登録がありません。 一般に評価の高い本を挙げてください)',
    '',
    '## すでに読んだ本 (提案しないでください)',
    alreadyRead || '(なし)',
    '',
    '## 制約',
    '- 実在する本だけを挙げてください。 タイトルと著者は正確に書いてください。',
    '- 上の一覧に出ている本と同じ本、 同じシリーズの既読巻は挙げないでください。',
    '- 傾向をなぞるだけでなく、 2〜3 冊は隣接ジャンルへの橋渡しを入れてください。',
    '- reason は日本語 60 字以内で 「良かった本のどこと繋がるか」 を書いてください。',
    '',
    '## 出力',
    'JSON 配列のみ。 前置き・コードフェンスの外の文章は不要です。',
    '[{"title": "...", "author": "...", "reason": "..."}]',
  ].join('\n');
}

export function parseSuggestOutput(raw: string): LlmBookProposal[] {
  const out: LlmBookProposal[] = [];
  for (const entry of extractJsonArray(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    if (!title) continue;
    out.push({
      title,
      author: typeof record.author === 'string' ? record.author.trim() : '',
      reason: typeof record.reason === 'string' ? record.reason.trim().slice(0, 200) : '',
    });
  }
  return out;
}
