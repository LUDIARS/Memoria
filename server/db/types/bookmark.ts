// bookmark domain — bookmarks / bookmark_categories / accesses
// Spec: spec/db/bookmark.md

/** 1 件のブックマーク。 SQLite から読んだ row そのまま (boolean は 0/1)。 */
export interface BookmarkRow {
  id: number;
  url: string;
  title: string;
  html_path: string;
  summary: string | null;
  memo: string;
  status: BookmarkStatus;
  error: string | null;
  created_at: string;        // UTC ISO
  updated_at: string;        // UTC ISO
  last_accessed_at: string | null; // UTC ISO
  access_count: number;
  // multi-server (Hub) 連携
  owner_user_id: string | null;
  owner_user_name: string | null;
  shared_at: string | null;  // UTC ISO
  shared_origin: string | null;
}

export type BookmarkStatus = 'pending' | 'done' | 'error';

/** ブックマーク ↔ カテゴリ junction. */
export interface BookmarkCategoryRow {
  bookmark_id: number;
  category: string;
}

/** ブックマーク開閉履歴。 */
export interface AccessRow {
  id: number;
  bookmark_id: number;
  accessed_at: string;       // UTC ISO
}
