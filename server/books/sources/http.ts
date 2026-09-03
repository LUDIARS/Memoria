// 書誌ソース共通の取得口。 SSRF ガード付きの fetchPublicText に寄せる。

import { fetchPublicText } from '../../shared/public-fetch.js';

const MAX_BYTES = 2 * 1024 * 1024;
const USER_AGENT = 'Memoria-Books/1.0 (personal bookshelf)';

export async function fetchJson<T>(url: string): Promise<T> {
  const result = await fetchPublicText(url, {
    accept: 'application/json',
    maxBytes: MAX_BYTES,
    userAgent: USER_AGENT,
  });
  return JSON.parse(result.text) as T;
}

export async function fetchXml(url: string): Promise<string> {
  const result = await fetchPublicText(url, {
    accept: 'application/xml, text/xml, application/rss+xml',
    maxBytes: MAX_BYTES,
    userAgent: USER_AGENT,
  });
  return result.text;
}

export interface CollectResult<T> {
  items: T[];
  error: string | null;
}

/** 失敗を呼び出し側でも判定できる収集結果。 */
export async function collectResult<T>(label: string, run: () => Promise<T[]>): Promise<CollectResult<T>> {
  try {
    return { items: await run(), error: null };
  } catch (error: unknown) {
    const message = `${label} failed: ${error instanceof Error ? error.message : String(error)}`;
    console.warn(`[books] ${message}`);
    return { items: [], error: message };
  }
}

/** ソース 1 本の失敗で巡回全体を止めないための包み。 失敗は空配列。 */
export async function safeCollect<T>(label: string, run: () => Promise<T[]>): Promise<T[]> {
  return (await collectResult(label, run)).items;
}
