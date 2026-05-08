// Note API client.
import type {
  NoteRow, NoteWithBlocks, NoteListResponse, NoteBlockRow,
  NoteBlockType, BlockData,
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

export function listNotes(query: string, limit = 50): Promise<NoteListResponse> {
  const p = new URLSearchParams();
  if (query) p.set('q', query);
  p.set('limit', String(limit));
  return api<NoteListResponse>(`/api/notes?${p.toString()}`);
}

export function getNote(id: number): Promise<NoteWithBlocks> {
  return api<NoteWithBlocks>(`/api/notes/${id}`);
}

export function createNote(input: {
  title?: string;
  kind?: string;
  tags?: string[];
  initial_blocks?: Array<{ block_type: NoteBlockType; text?: string; data?: BlockData | null }>;
}): Promise<NoteRow> {
  return api<NoteRow>('/api/notes', asJson(input));
}

export function patchNote(id: number, patch: { title?: string; kind?: string; tags?: string[] }): Promise<NoteRow> {
  return api<NoteRow>(`/api/notes/${id}`, { ...asJson(patch), method: 'PATCH' });
}

export function deleteNote(id: number): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/notes/${id}`, { method: 'DELETE' });
}

export function createBlock(
  noteId: number,
  body: { block_type: NoteBlockType; text?: string; data?: BlockData | null; after_block_id?: number | null },
): Promise<NoteBlockRow> {
  return api<NoteBlockRow>(`/api/notes/${noteId}/blocks`, asJson(body));
}

export function patchBlock(
  noteId: number,
  blockId: number,
  body: { block_type?: NoteBlockType; text?: string; data?: BlockData | null },
): Promise<NoteBlockRow> {
  return api<NoteBlockRow>(`/api/notes/${noteId}/blocks/${blockId}`, { ...asJson(body), method: 'PATCH' });
}

export function deleteBlock(noteId: number, blockId: number): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/notes/${noteId}/blocks/${blockId}`, { method: 'DELETE' });
}

export function reorderBlocks(noteId: number, order: number[]): Promise<{ ok: true; blocks: NoteBlockRow[] }> {
  return api<{ ok: true; blocks: NoteBlockRow[] }>(`/api/notes/${noteId}/blocks/reorder`, asJson({ order }));
}
