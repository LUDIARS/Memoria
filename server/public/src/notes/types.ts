// Frontend types — mirror server/api/types/note.ts (subset).
// Spec: spec/api/note.md

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

export interface NoteRow {
  id: number;
  title: string;
  kind: string;
  tags_json: string | null;
  source_kind: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface NoteSummary {
  id: number;
  title: string;
  kind: string;
  tags: string[];
  source_kind: string | null;
  source_ref: string | null;
  block_count: number;
  preview: string;
  created_at: string;
  updated_at: string;
}

export interface NoteListResponse {
  items: NoteSummary[];
  total: number;
}

export interface NoteWithBlocks extends NoteRow {
  tags: string[];
  blocks: NoteBlockRow[];
}

export interface BlockData {
  lang?: string;
  header?: boolean;
  rows?: string[][];
  indent?: number;
  checked?: boolean;
}
