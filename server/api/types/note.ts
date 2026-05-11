// note API request/response types (rev2)
// Spec: spec/api/note.md

import type {
  NoteRow, NoteBlockRow, NoteBlockType, NoteKind,
  NoteCommentSetRow, NoteCommentRow,
} from '../../db/types/note.js';

export interface NoteSummary {
  id: string;                  // UUID
  title: string;
  kind: NoteKind;
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

export interface NoteCreateRequest {
  title?: string;
  kind?: NoteKind;
  tags?: string[];
  bookmark_id?: number | null;
  bookmark_url?: string | null;
  source_kind?: string | null;
  source_ref?: string | null;
  initial_blocks?: BlockCreateRequest[];
}

export interface NoteUpdateRequest {
  title?: string;
  kind?: NoteKind;
  tags?: string[];
  bookmark_id?: number | null;
  bookmark_url?: string | null;
}

export interface BlockCreateRequest {
  block_type: NoteBlockType;
  text?: string;
  data?: Record<string, unknown> | null;
  after_block_uuid?: string | null;
}

export interface BlockUpdateRequest {
  block_type?: NoteBlockType;
  text?: string;
  data?: Record<string, unknown> | null;
}

export interface BlockReorderRequest {
  // 全 block UUID を含む順序列。 1.0, 2.0, … で再採番
  order: string[];
}

export interface BlockReorderResponse {
  ok: true;
  blocks: NoteBlockRow[];
}

// ── コメント ──────────────────────────────────────────────────────────

export interface CommentSetWithComments extends NoteCommentSetRow {
  comments: NoteCommentRow[];
}

export interface CommentSetCreateRequest {
  owner_user_id?: string | null;
  owner_user_name?: string | null;
}

export interface CommentCreateRequest {
  text: string;
  target_block_uuid?: string | null;
  data?: Record<string, unknown> | null;
  position?: number;
}

export interface CommentUpdateRequest {
  text?: string;
  target_block_uuid?: string | null;
  data?: Record<string, unknown> | null;
}

// ── Notion 取り込み ──────────────────────────────────────────────────

export type NotionBlockKind =
  | 'heading_1' | 'heading_2' | 'heading_3'
  | 'text' | 'quote' | 'todo'
  | 'bullet_list' | 'numbered_list'
  | 'code' | 'divider'
  /// Notion の `/bookmark` block (URL preview)。 Memoria 側では bookmark_embed
  /// (bookmark_id=null + bookmark_url + title? + summary? + image?) として保存。
  | 'bookmark';

export type NotionExtractedBlock =
  | { kind: 'heading_1' | 'heading_2' | 'heading_3' | 'text' | 'quote'; text: string }
  | { kind: 'todo'; text: string; checked?: boolean }
  | { kind: 'bullet_list' | 'numbered_list'; text: string; indent?: number }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'divider' }
  | { kind: 'bookmark'; url: string; title?: string; caption?: string; image?: string };

// ── URL preview (Notion 風 ad-hoc bookmark card) ──────────────────────

export interface UrlPreviewRequest {
  url: string;
}

export interface UrlPreviewResponse {
  url: string;
  /// 既に bookmark として保存済みなら id を返す (= 既存カード経路に切替)。
  /// 未保存なら null で、 bookmark_embed の data に bookmark_id=null で挿入する想定。
  bookmark_id: number | null;
  title: string;
  description: string;
  image: string | null;
  site_name: string | null;
  ok: boolean;
  /// ok=false 時のエラーメッセージ (UI 表示用)
  error?: string;
  /// どの経路で metadata を取ったか (UI で「extension cache から」 等表示)
  source?: 'extension-scrape' | 'bookmark-row' | 'server-fetch';
}

export interface NoteFromNotionRequest {
  url: string;
  page_id?: string | null;
  title: string;
  blocks: NotionExtractedBlock[];
  memo?: string;
  also_bookmark?: boolean;
}

export interface NoteFromNotionResponse {
  note: import('../../db/types/note.js').NoteRow;
  blocks_inserted: number;
  bookmark_id?: number | null;
}

// ── 拡張からのチャット取り込み (既存) ─────────────────────────────────

export type ChatExtractionSource = 'chatgpt' | 'claude' | 'gemini';

export interface ChatExtractedMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts?: string | null;
}

export interface NoteFromChatRequest {
  source: ChatExtractionSource;
  url: string;
  conversation_id?: string | null;
  title: string;
  messages: ChatExtractedMessage[];
  also_create_note: boolean;
  memo?: string;
}

export interface NoteFromChatResponse {
  note: NoteRow | null;
  messages_saved: number;
}

// ── 拡張ルール (extension dispatch 設定 — 既存) ────────────────────────

export interface ExtensionChatDomain {
  host: string;
  source: ChatExtractionSource;
  enabled: boolean;
}

export interface ExtensionImplRule {
  label: string;
  host_pattern: string;
  keywords: string[];
  enabled: boolean;
}

export interface ExtensionShoppingDomain {
  host: string;
  label: string;
  enabled: boolean;
}

export interface ExtensionNotionDomain {
  host: string;
  enabled: boolean;
}

export interface ExtensionRules {
  chat_domains: ExtensionChatDomain[];
  impl_rules: ExtensionImplRule[];
  shopping_domains: ExtensionShoppingDomain[];
  notion_domains: ExtensionNotionDomain[];
}

export type ExtensionRulesUpdateRequest = Partial<ExtensionRules>;
