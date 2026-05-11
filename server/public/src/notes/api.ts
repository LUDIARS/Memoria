// Note API client (rev2 — UUID + bookmark + comments)
import type {
  NoteRow, NoteWithBlocks, NoteListResponse, NoteBlockRow,
  NoteBlockType, BlockData,
  CommentSetRow, CommentRow, CommentSetWithComments,
  BookmarkSummary,
} from './types.js';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function asJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  };
}

// ── notes ───────────────────────────────────────────────────────────

export function listNotes(query: string, limit = 50, bookmarkId?: number | null): Promise<NoteListResponse> {
  const p = new URLSearchParams();
  if (query) p.set('q', query);
  p.set('limit', String(limit));
  if (bookmarkId != null) p.set('bookmark_id', String(bookmarkId));
  return api<NoteListResponse>(`/api/notes?${p.toString()}`);
}

export function getNote(uuid: string): Promise<NoteWithBlocks> {
  return api<NoteWithBlocks>(`/api/notes/${encodeURIComponent(uuid)}`);
}

export function createNote(input: {
  title?: string;
  kind?: string;
  tags?: string[];
  bookmark_id?: number | null;
  bookmark_url?: string | null;
  initial_blocks?: Array<{ block_type: NoteBlockType; text?: string; data?: BlockData | null }>;
}): Promise<NoteRow> {
  return api<NoteRow>('/api/notes', asJson(input));
}

export function patchNote(uuid: string, patch: { title?: string; kind?: string; tags?: string[]; bookmark_id?: number | null; bookmark_url?: string | null }): Promise<NoteRow> {
  return api<NoteRow>(`/api/notes/${encodeURIComponent(uuid)}`, { ...asJson(patch), method: 'PATCH' });
}

export function deleteNote(uuid: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/notes/${encodeURIComponent(uuid)}`, { method: 'DELETE' });
}

// ── blocks ──────────────────────────────────────────────────────────

export function createBlock(
  noteUuid: string,
  body: { block_type: NoteBlockType; text?: string; data?: BlockData | null; after_block_uuid?: string | null },
): Promise<NoteBlockRow> {
  return api<NoteBlockRow>(`/api/notes/${encodeURIComponent(noteUuid)}/blocks`, asJson(body));
}

export function patchBlock(
  noteUuid: string,
  blockUuid: string,
  body: { block_type?: NoteBlockType; text?: string; data?: BlockData | null },
): Promise<NoteBlockRow> {
  return api<NoteBlockRow>(`/api/notes/${encodeURIComponent(noteUuid)}/blocks/${encodeURIComponent(blockUuid)}`, { ...asJson(body), method: 'PATCH' });
}

export function deleteBlock(noteUuid: string, blockUuid: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/notes/${encodeURIComponent(noteUuid)}/blocks/${encodeURIComponent(blockUuid)}`, { method: 'DELETE' });
}

export function reorderBlocks(noteUuid: string, order: string[]): Promise<{ ok: true; blocks: NoteBlockRow[] }> {
  return api<{ ok: true; blocks: NoteBlockRow[] }>(`/api/notes/${encodeURIComponent(noteUuid)}/blocks/reorder`, asJson({ order }));
}

// ── comments ────────────────────────────────────────────────────────

export function listCommentSets(noteUuid: string, ownerUserId?: string | null): Promise<{ items: CommentSetWithComments[] }> {
  const p = new URLSearchParams();
  if (ownerUserId !== undefined) p.set('owner_user_id', ownerUserId === null ? 'null' : ownerUserId);
  const qs = p.toString() ? `?${p}` : '';
  return api<{ items: CommentSetWithComments[] }>(`/api/notes/${encodeURIComponent(noteUuid)}/comment-sets${qs}`);
}

export function getOrCreateCommentSet(noteUuid: string, ownerUserId: string | null = null): Promise<CommentSetRow> {
  return api<CommentSetRow>(`/api/notes/${encodeURIComponent(noteUuid)}/comment-sets`, asJson({ owner_user_id: ownerUserId }));
}

export function createComment(
  noteUuid: string,
  setUuid: string,
  body: { text: string; target_block_uuid?: string | null },
): Promise<CommentRow> {
  return api<CommentRow>(`/api/notes/${encodeURIComponent(noteUuid)}/comment-sets/${encodeURIComponent(setUuid)}/comments`, asJson(body));
}

export function patchComment(
  noteUuid: string,
  setUuid: string,
  commentUuid: string,
  body: { text?: string; target_block_uuid?: string | null },
): Promise<CommentRow> {
  return api<CommentRow>(
    `/api/notes/${encodeURIComponent(noteUuid)}/comment-sets/${encodeURIComponent(setUuid)}/comments/${encodeURIComponent(commentUuid)}`,
    { ...asJson(body), method: 'PATCH' },
  );
}

export function deleteComment(noteUuid: string, setUuid: string, commentUuid: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(
    `/api/notes/${encodeURIComponent(noteUuid)}/comment-sets/${encodeURIComponent(setUuid)}/comments/${encodeURIComponent(commentUuid)}`,
    { method: 'DELETE' },
  );
}

// ── bookmark picker ─────────────────────────────────────────────────

export async function searchBookmarks(query: string, limit = 20): Promise<BookmarkSummary[]> {
  const p = new URLSearchParams();
  if (query) p.set('q', query);
  p.set('limit', String(limit));
  const res = await api<{ items: BookmarkSummary[] }>(`/api/bookmarks?${p.toString()}`);
  return res.items;
}

// ── URL preview (Notion 風 ad-hoc bookmark card) ──────────────────────

export interface UrlPreviewResponse {
  url: string;
  bookmark_id: number | null;
  title: string;
  description: string;
  image: string | null;
  site_name: string | null;
  ok: boolean;
  error?: string;
  source?: 'extension-scrape' | 'bookmark-row' | 'server-fetch';
}

export function urlPreview(url: string): Promise<UrlPreviewResponse> {
  return api<UrlPreviewResponse>('/api/notes/url-preview', asJson({ url }));
}
