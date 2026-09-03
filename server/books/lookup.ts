// 登録フォーム用の書誌検索。
//
// Google Books はキー無しで使えるぶん共有 IP の quota に当たりやすく、 429 を返す。
// そこで 1 ソースの失敗で 500 にせず、 NDL へ落として結果だけ返す。 全滅しても
// 候補 0 件 + warning で返し、 手入力での登録を止めない。

import { effectiveSources } from './config.js';
import { searchGoogleBooks } from './sources/google-books.js';
import { searchNdl } from './sources/ndl.js';
import { enrichWithOpenBd } from './sources/openbd.js';
import { titleKey } from './bib.js';
import type { BookCandidate, BooksConfig } from './types.js';

/** 差し替え可能なソース (テストと、 将来のソース追加のため)。 */
export interface LookupDeps {
  searchGoogleBooks?: typeof searchGoogleBooks;
  searchNdl?: typeof searchNdl;
  enrichWithOpenBd?: typeof enrichWithOpenBd;
}

export interface LookupResult {
  candidates: BookCandidate[];
  /** 画面に出す注意書き。 全ソース成功なら null。 */
  warning: string | null;
}

export interface BibliographyLookupQuery {
  title: string;
  author?: string;
}

/** 同じ本が複数ソースから来るので titleKey で畳む。 先に来たソースを優先する。 */
function dedupe(candidates: BookCandidate[]): BookCandidate[] {
  const seen = new Set<string>();
  const out: BookCandidate[] = [];
  for (const candidate of candidates) {
    const key = titleKey(candidate.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

export async function lookupBibliography(
  config: BooksConfig,
  query: BibliographyLookupQuery,
  deps: LookupDeps = {},
): Promise<LookupResult> {
  const searchGoogle = deps.searchGoogleBooks ?? searchGoogleBooks;
  const searchLibrary = deps.searchNdl ?? searchNdl;
  const enrich = deps.enrichWithOpenBd ?? enrichWithOpenBd;
  const sources = effectiveSources(config);
  const failures: string[] = [];
  const collected: BookCandidate[] = [];

  if (sources.googleBooks) {
    try {
      const freeText = [query.title, query.author].filter(Boolean).join(' ');
      collected.push(...await searchGoogle({ freeText, limit: 10 }));
    } catch {
      // 外部応答の本文や URL をブラウザへ反射せず、失敗したソースだけを知らせる。
      failures.push('Google Books');
    }
  }

  // Google が 429 等で落ちたときだけ NDL を叩く (和書は NDL でだいたい引ける)。
  if (sources.ndl && collected.length === 0) {
    try {
      collected.push(...await searchLibrary({ title: query.title, creator: query.author, limit: 10 }));
    } catch {
      failures.push('NDL サーチ');
    }
  }

  const candidates = dedupe(collected);
  if (sources.openbd && candidates.length > 0) {
    try {
      return { candidates: await enrich(candidates), warning: warningOf(failures) };
    } catch {
      failures.push('openBD');
    }
  }
  return { candidates, warning: warningOf(failures) };
}

function warningOf(failures: string[]): string | null {
  if (failures.length === 0) return null;
  return `一部の書誌ソースが応答しませんでした (${failures.join(' / ')})`;
}
