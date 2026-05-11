// note domain — notes / note_blocks / note_comment_sets / note_comments
// Spec: spec/db/note.md

export type NoteKind = 'doc' | 'chat' | 'bookmark' | 'meeting' | string;

export interface NoteRow {
  id: string;                   // UUID
  title: string;
  kind: NoteKind;
  tags_json: string | null;
  bookmark_id: number | null;   // ベース bookmark (NULL = フリーノート)
  bookmark_url: string | null;  // 冗長保存 (Hub 同期 / bookmark 削除耐性)
  source_kind: string | null;
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
  | 'divider'
  | 'floating_text'
  | 'canvas'
  | 'bookmark_embed'
  | 'note_link';

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
  'floating_text',
  'canvas',
  'bookmark_embed',
  'note_link',
] as const;

export interface NoteBlockRow {
  id: number;                  // DB 内部 (join 用)
  uuid: string;                // portable UUID — comment が target にする
  note_id: string;             // notes.id (UUID)
  position: number;
  block_type: NoteBlockType;
  text: string;
  data_json: string | null;
  created_at: string;
  updated_at: string;
}

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
  // floating_text (bookmark canvas)
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  anchor?: FloatingAnchor;
  // bookmark_embed
  // bookmark_id が null の場合は ad-hoc URL カード (= Notion の /bookmark 同等)
  bookmark_id?: number | null;
  bookmark_url?: string;
  // note_link
  note_id?: string;
  // shared by bookmark_embed & note_link (キャッシュ)
  title?: string;
  summary?: string;
  // bookmark_embed: og:image (Notion 風 URL preview card)
  image?: string;
  site_name?: string;

  // canvas (drawing)
  /// SVG パスのストローク列。 各要素は polyline 形式 "x,y x,y …" を持つ。
  paths?: CanvasPath[];
  /// canvas の論理サイズ (px)。 デフォルト 800x500。
  canvasWidth?: number;
  canvasHeight?: number;

  // ── 全 block 共通 (Notion ライク装飾) ──────────────────────────────────
  /// CSS 色 (#rrggbb / rgb() / 名前) を許可。 空文字 = クリア。
  bgColor?: string;
}

/// 1 ストローク = 1 つの折れ線。 `points` は "x1,y1 x2,y2 …" (SVG polyline 形)。
/// 圧縮性重視で座標は整数 px (粒度 1px) で保存。
export interface CanvasPath {
  points: string;
  color: string;
  width: number;
}

export type FloatingAnchor =
  | { kind: 'point' }
  | { kind: 'text'; selector: string; startOffset: number; endOffset: number };

// ── コメント (per note × user) ──────────────────────────────────────────

export interface NoteCommentSetRow {
  id: string;                       // UUID
  note_id: string;                  // notes.id (UUID)
  owner_user_id: string | null;     // NULL = ローカル自分
  owner_user_name: string | null;
  created_at: string;
  updated_at: string;
  shared_at: string | null;
  shared_origin: string | null;
}

export interface NoteCommentRow {
  id: string;                       // UUID
  set_id: string;                   // FK → note_comment_sets.id
  target_block_uuid: string | null; // NULL = note 全体宛て
  position: number;
  text: string;
  data_json: string | null;
  created_at: string;
  updated_at: string;
}
