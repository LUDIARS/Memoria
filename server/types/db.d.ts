// Shared types for the local server's SQLite layer.
//
// Phase 1 of the TS migration (#31) lays the groundwork. As individual
// modules grow `// @ts-check` directives (or migrate to `.ts`), they import
// these shapes via `import('./types/db.js')` JSDoc annotations.
import type Database from 'better-sqlite3';

export type Db = Database.Database;

export interface BookmarkRow {
  id: number;
  url: string;
  title: string;
  html_path: string;
  summary: string | null;
  memo: string;
  status: 'pending' | 'done' | 'error';
  error: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  access_count: number;
  // Phase 1 share-metadata columns (NULL = "this is mine" on a local DB).
  owner_user_id: string | null;
  owner_user_name: string | null;
  shared_at: string | null;
  shared_origin: string | null;
}

export interface DigSessionRow {
  id: number;
  query: string;
  created_at: string;
  status: 'pending' | 'done' | 'error';
  error: string | null;
  result_json: string | null;
  preview_json: string | null;
  owner_user_id: string | null;
  owner_user_name: string | null;
  shared_at: string | null;
  shared_origin: string | null;
}

export interface DictionaryEntryRow {
  id: number;
  term: string;
  definition: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  owner_user_id: string | null;
  owner_user_name: string | null;
  shared_at: string | null;
  shared_origin: string | null;
}

export interface ServerEventRow {
  id: number;
  type: 'start' | 'stop' | 'downtime' | 'restart';
  occurred_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  details_json: string | null;
}

// Multi-server connection state stored under app_settings keys.
export interface MultiState {
  url: string | null;
  jwt: string | null;
  userId: string | null;
  userName: string | null;
  role: 'user' | 'moderator' | 'admin' | null;
  connectedAt: string | null;
}
