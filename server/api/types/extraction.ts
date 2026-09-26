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
  note: {id:string;title:string};
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
  note: {id:string;title:string} | null;
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

export interface ExtensionFurusatoDomain {
  host: string;
  label: string;
  enabled: boolean;
}

export interface ExtensionRules {
  chat_domains: ExtensionChatDomain[];
  impl_rules: ExtensionImplRule[];
  shopping_domains: ExtensionShoppingDomain[];
  notion_domains: ExtensionNotionDomain[];
  furusato_domains: ExtensionFurusatoDomain[];
}

export type ExtensionRulesUpdateRequest = Partial<ExtensionRules>;
