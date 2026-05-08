// note domain — notes / note_blocks
// Spec: spec/db/note.md

export type NoteKind = 'doc' | 'chat' | 'meeting' | string;

export interface NoteRow {
  id: number;
  title: string;
  kind: NoteKind;
  tags_json: string | null;     // JSON string[]
  source_kind: string | null;   // 'chat' | …
  source_ref: string | null;
  created_at: string;
  updated_at: string;
  // Hub 連携 (Phase 2 予約)
  owner_user_id: string | null;
  owner_user_name: string | null;
  shared_at: string | null;
  shared_origin: string | null;
}

export type NoteBlockType =
  | 'text'
  | 'heading_1'
  | 'heading_2'
  | 'heading_3'
  | 'quote'
  | 'code'
  | 'mermaid'
  | 'table'
  | 'bullet_list'
  | 'numbered_list'
  | 'todo'
  | 'divider';

export const NOTE_BLOCK_TYPES: readonly NoteBlockType[] = [
  'text',
  'heading_1',
  'heading_2',
  'heading_3',
  'quote',
  'code',
  'mermaid',
  'table',
  'bullet_list',
  'numbered_list',
  'todo',
  'divider',
] as const;

export interface NoteBlockRow {
  id: number;
  note_id: number;
  position: number;
  block_type: NoteBlockType;
  text: string;
  data_json: string | null;
  created_at: string;
  updated_at: string;
}

// data_json の中身 (パース後の型)。 type ごとに optional フィールドが異なる。
export interface NoteBlockData {
  // code
  lang?: string;
  // table
  header?: boolean;
  rows?: string[][];
  // bullet_list / numbered_list
  indent?: number;
  // todo
  checked?: boolean;
}
