// note API request/response types
// Spec: spec/api/note.md

import type { NoteRow, NoteBlockRow, NoteBlockType, NoteKind } from '../../db/types/note.js';

export interface NoteSummary {
  id: number;
  title: string;
  kind: NoteKind;
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
  tags: string[];          // tags_json をパース済
  blocks: NoteBlockRow[];
}

export interface NoteCreateRequest {
  title?: string;
  kind?: NoteKind;
  tags?: string[];
  source_kind?: string | null;
  source_ref?: string | null;
  // 初期ブロック (空でも note は作れる)
  initial_blocks?: BlockCreateRequest[];
}

export interface NoteUpdateRequest {
  title?: string;
  kind?: NoteKind;
  tags?: string[];
}

export interface BlockCreateRequest {
  block_type: NoteBlockType;
  text?: string;
  data?: Record<string, unknown> | null;
  // 挿入位置: 末尾なら省略 (= 現在 max position + 1)、 中間挿入なら after_block_id を指定
  after_block_id?: number | null;
}

export interface BlockUpdateRequest {
  block_type?: NoteBlockType;
  text?: string;
  data?: Record<string, unknown> | null;
}

export interface BlockReorderRequest {
  // note 配下のすべての block id を含む順序列。 1.0, 2.0, … で再採番
  order: number[];
}

export interface BlockReorderResponse {
  ok: true;
  blocks: NoteBlockRow[];
}

// extension からのチャット取り込み
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
  note: NoteRow | null;     // also_create_note=false なら null
  messages_saved: number;
}

// 拡張ルール (extension dispatch 設定)

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

export interface ExtensionRules {
  chat_domains: ExtensionChatDomain[];
  impl_rules: ExtensionImplRule[];
  shopping_domains: ExtensionShoppingDomain[];
}

export type ExtensionRulesUpdateRequest = Partial<ExtensionRules>;
