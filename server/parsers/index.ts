// Reparse entry — bookmark の保存済 HTML から chat / notion を auto-detect して
// 抽出する。 個別 parser は ./chat と ./notion を参照。

import { detectChatSourceByUrl, extractChatMessages, extractChatTitle } from './chat.js';
import { isNotionUrl, extractNotionTitle, extractNotionPageId, extractNotionBlocks } from './notion.js';
import type { ChatExtractionSource, ChatExtractedMessage, NotionExtractedBlock } from '../api/types/note.js';

export type ReparseKind = 'chat' | 'notion';

export interface ChatReparseResult {
  kind: 'chat';
  source: ChatExtractionSource;
  title: string;
  messages: ChatExtractedMessage[];
}

export interface NotionReparseResult {
  kind: 'notion';
  title: string;
  page_id: string | null;
  blocks: NotionExtractedBlock[];
}

export type ReparseResult = ChatReparseResult | NotionReparseResult;

export function detectReparseKind(url: string): ReparseKind | null {
  if (detectChatSourceByUrl(url)) return 'chat';
  if (isNotionUrl(url)) return 'notion';
  return null;
}

export function reparseHtml(url: string, html: string, opts?: {
  kind?: ReparseKind;
  chat_source?: ChatExtractionSource;
}): ReparseResult | null {
  const kind = opts?.kind ?? detectReparseKind(url);
  if (!kind) return null;

  if (kind === 'chat') {
    const source = opts?.chat_source ?? detectChatSourceByUrl(url);
    if (!source) return null;
    const messages = extractChatMessages(html, source);
    const title = extractChatTitle(html);
    return { kind: 'chat', source, title, messages };
  }
  if (kind === 'notion') {
    const blocks = extractNotionBlocks(html);
    const title = extractNotionTitle(html);
    const page_id = extractNotionPageId(url);
    return { kind: 'notion', title, page_id, blocks };
  }
  return null;
}
