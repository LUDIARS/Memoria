// 書誌 API が引けなかったときの LLM 補完。
//
// Google Books は共有 quota で 429 を返すことがあり、 NDL も表記次第で 0 件になる。
// そのとき 「タイトルだけ・著者空」 の行が残ると、 著者ウォッチもサジェストも効かない。
// LLM に著者・ISBN・出版社を出させて埋める。
//
// LLM の出す ISBN は当てにならないので、 **openBD で実在確認できたものだけ**採用する。
// 確認できなければ ISBN も出版社も発売日も捨て、 著者だけ 「推定」 として残す。

import { runLlm } from '../llm.js';
import { cleanAuthors, normalizeDate, normalizeIsbn13 } from './bib.js';
import { lookupOpenBd } from './sources/openbd.js';
import type { BookCandidate } from './types.js';

export type LlmRunner = (prompt: string) => Promise<string>;

export interface LlmBibDeps {
  runLlm?: LlmRunner;
  lookupOpenBd?: typeof lookupOpenBd;
}

const defaultRunner: LlmRunner = (prompt) => runLlm({
  task: 'book_bib_lookup',
  prompt,
  tools: [],
  timeoutMs: 120_000,
});

export function buildBibPrompt(title: string, author?: string): string {
  return [
    'あなたは書誌データベースの司書です。 次の本の書誌情報を答えてください。',
    '',
    `タイトル: ${title}`,
    author ? `著者 (利用者の入力): ${author}` : '著者: 不明',
    '',
    '## 制約',
    '- 知っている本だけ答えてください。 心当たりが無ければ `null` を返してください。',
    '- ISBN は日本語版の単行本 / 文庫の ISBN-13 を、 確信がある場合だけ書いてください。',
    '  自信が無ければ isbn13 は null にしてください (誤った ISBN は書かないでください)。',
    '- authors は著者名だけ。 「著」 「作画」 などの役割語は付けないでください。',
    '- publishedOn は第 1 巻 / 初版の発売年月 (YYYY-MM または YYYY-MM-DD)。',
    '',
    '## 出力',
    'JSON オブジェクト 1 つだけ。 前置き不要。',
    '{"title": "...", "authors": ["..."], "isbn13": "...", "publisher": "...", "publishedOn": "..."}',
    '心当たりが無い場合: null',
  ].join('\n');
}

interface LlmBibRecord {
  title: string;
  authors: string[];
  isbn13: string | null;
  publisher: string | null;
  publishedOn: string | null;
}

/** コードフェンス・前置き付きの出力から最初の JSON オブジェクトを取り出す。 */
export function parseBibOutput(raw: string, fallbackTitle: string): LlmBibRecord | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced ? fenced[1] : raw).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const authors = Array.isArray(record.authors)
    ? cleanAuthors(record.authors
      .filter((value): value is string => typeof value === 'string' && value.length <= 120)
      .slice(0, 20))
    : [];
  const proposedTitle = typeof record.title === 'string' ? record.title.trim() : '';
  const title = proposedTitle && proposedTitle.length <= 300 ? proposedTitle : fallbackTitle;
  const isbn13 = normalizeIsbn13(typeof record.isbn13 === 'string' ? record.isbn13 : null);
  const publisher = typeof record.publisher === 'string' ? record.publisher.trim() : '';
  // 裏取りなしでは捨てる出版社しかない返答や、不正 ISBN だけの返答は空と同じ。
  if (authors.length === 0 && !isbn13) return null;
  return {
    title,
    authors,
    isbn13,
    publisher: publisher && publisher.length <= 120 ? publisher : null,
    publishedOn: normalizeDate(typeof record.publishedOn === 'string' ? record.publishedOn : null),
  };
}

/**
 * LLM に書誌を尋ね、 ISBN は openBD で裏を取ってから返す。
 * 何も得られなければ null (呼び出し側は入力のまま登録する)。
 */
export async function inferBibliography(
  title: string,
  author: string | undefined,
  deps: LlmBibDeps = {},
): Promise<BookCandidate | null> {
  const runner = deps.runLlm ?? defaultRunner;
  const openBd = deps.lookupOpenBd ?? lookupOpenBd;

  const record = parseBibOutput(await runner(buildBibPrompt(title, author)), title);
  if (!record) return null;

  // 裏の取れない推定は **著者だけ** 採る。 出版社・発売日は LLM がよく間違えるうえ
  // (実測: トリリオンゲームの版元を集英社と答えた)、 表示に出ると誤情報がそのまま残る。
  // 著者はウォッチ対象の導出に要るので、 多少の表記ゆれを承知で残す。
  const base: BookCandidate = {
    isbn13: null,
    title: record.title,
    authors: record.authors,
    publisher: null,
    series: null,
    publishedOn: null,
    coverUrl: null,
    url: null,
    source: 'llm_inferred',
    rating: null,
    ratingCount: null,
    salesRank: null,
  };
  if (!record.isbn13) return base;

  // ISBN は幻を掴みやすい。 openBD に実在すればそこの書誌を正として使う。
  try {
    const verified = (await openBd([record.isbn13])).get(record.isbn13);
    if (!verified) return base;
    return {
      ...verified,
      // openBD の書誌を正としつつ、 LLM が補った著者は openBD が空のときだけ使う。
      authors: verified.authors.length > 0 ? verified.authors : base.authors,
      source: 'llm_inferred',
    };
  } catch {
    return base;
  }
}
