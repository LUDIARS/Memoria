// ブックマーク登録。 URL を既存 POST /api/bookmarks/from-url に委譲する
// (fetch + 保存 + 要約キュー投入まで既存パイプラインが行う)。

import { apiPostJson } from '../http.js';

/** メッセージ本文から最初の URL を抜き出す。 無ければ null。 */
export function extractFirstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"')]+/);
  return m ? m[0] : null;
}

export async function createBookmark(url: string): Promise<string> {
  const res = await apiPostJson('/api/bookmarks/from-url', { url });
  if (!res.ok) return `ブックマーク失敗 (${res.status})`;
  const json = await res.json().catch(() => ({})) as { duplicate?: boolean; title?: string };
  if (json.duplicate) return `既に登録済: ${url}`;
  return `ブックマーク登録: ${json.title ?? url}`;
}
