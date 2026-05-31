// Frontend types — mirror server/api/types/note.ts (rev2)
// Spec: spec/interface/note.md

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
  | 'divider'
  | 'floating_text'
  | 'canvas'
  | 'bookmark_embed'
  | 'note_link';

export interface NoteBlockRow {
  id: number;            // DB internal (server only — frontend は uuid を使う)
  uuid: string;          // portable UUID
  note_id: string;       // notes.id (UUID)
  position: number;
  block_type: NoteBlockType;
  text: string;
  data_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface NoteRow {
  id: string;            // UUID
  title: string;
  kind: string;
  tags_json: string | null;
  bookmark_id: number | null;
  bookmark_url: string | null;
  source_kind: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface NoteSummary {
  id: string;
  title: string;
  kind: string;
  tags: string[];
  bookmark_id: number | null;
  bookmark_url: string | null;
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
  // code
  lang?: string;
  // table
  header?: boolean;
  rows?: string[][];
  // bullet_list / numbered_list
  indent?: number;
  // todo
  checked?: boolean;
  // floating_text
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  anchor?: FloatingAnchor;
  // bookmark_embed (bookmark_id が null = ad-hoc URL カード = Notion /bookmark 風)
  bookmark_id?: number | null;
  bookmark_url?: string;
  // note_link
  note_id?: string;
  // shared
  title?: string;
  summary?: string;
  // bookmark_embed: og:image (Notion 風 URL preview card)
  image?: string;
  site_name?: string;
  // canvas (drawing)
  paths?: CanvasPath[];
  canvasWidth?: number;
  canvasHeight?: number;
  // ── 全 block 共通 (Notion ライク装飾) ──
  bgColor?: string;
}

export interface CanvasPath {
  points: string;
  color: string;
  width: number;
}

export type FloatingAnchor =
  | { kind: 'point' }
  | { kind: 'text'; selector: string; startOffset: number; endOffset: number };

// ── コメント ──────────────────────────────────────────────────────────

export interface CommentSetRow {
  id: string;                       // UUID
  note_id: string;                  // notes.id (UUID)
  owner_user_id: string | null;
  owner_user_name: string | null;
  created_at: string;
  updated_at: string;
  shared_at: string | null;
  shared_origin: string | null;
}

export interface CommentRow {
  id: string;                       // UUID
  set_id: string;
  target_block_uuid: string | null;
  position: number;
  text: string;
  data_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommentSetWithComments extends CommentSetRow {
  comments: CommentRow[];
}

// ── bookmark picker 用 ───────────────────────────────────────────────

export interface BookmarkSummary {
  id: number;
  url: string;
  title: string;
  summary: string | null;
  categories: string[] | null;
  created_at: string;
}
