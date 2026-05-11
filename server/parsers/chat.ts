// Chat extractor — 保存済 HTML (ChatGPT / Claude / Gemini) から会話メッセージを抽出する。
//
// extension/content.js の extractChatGpt / extractClaude / extractGemini を
// サーバ側で再現したもの。 後から強化したパース処理を、 bookmark 時の HTML
// スナップショットに対して再実行できるようにするのが目的。
//
// extension は実行時 DOM を直接読むが、 ここでは保存済 HTML (= レンダリング後
// だが JS は走らない静的 HTML) を node-html-parser で解析する。

import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import type { ChatExtractionSource, ChatExtractedMessage } from '../api/types/note.js';

export function detectChatSourceByUrl(url: string): ChatExtractionSource | null {
  if (!url) return null;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  if (host.endsWith('chatgpt.com') || host.endsWith('chat.openai.com')) return 'chatgpt';
  if (host.endsWith('claude.ai')) return 'claude';
  if (host.endsWith('gemini.google.com')) return 'gemini';
  return null;
}

export function extractChatMessages(html: string, source: ChatExtractionSource): ChatExtractedMessage[] {
  const root = parseHtml(html, { lowerCaseTagName: false });
  switch (source) {
    case 'chatgpt': return extractChatGpt(root);
    case 'claude':  return extractClaude(root);
    case 'gemini':  return extractGemini(root);
    default: return [];
  }
}

function textOf(el: HTMLElement): string {
  // node-html-parser の textContent は再帰的に textNode を結合。 連続空白の整理だけ最低限。
  return (el.textContent ?? '').replace(/\s+\n/g, '\n').replace(/[\t ]+/g, ' ').trim();
}

function extractChatGpt(root: HTMLElement): ChatExtractedMessage[] {
  const out: ChatExtractedMessage[] = [];
  const els = root.querySelectorAll('[data-message-author-role][data-message-id]');
  for (const el of els) {
    const role = el.getAttribute('data-message-author-role') ?? '';
    const text = textOf(el);
    if (!text) continue;
    out.push({
      role: role === 'assistant' ? 'assistant' : (role === 'system' ? 'system' : 'user'),
      text,
    });
  }
  return out;
}

function extractClaude(root: HTMLElement): ChatExtractedMessage[] {
  const out: ChatExtractedMessage[] = [];
  // data-testid ベース (新 UI)
  const primary = root.querySelectorAll('[data-testid="user-message"], [data-testid="message-content"]');
  if (primary.length > 0) {
    for (const el of primary) {
      const role = el.getAttribute('data-testid') === 'user-message' ? 'user' : 'assistant';
      const text = textOf(el);
      if (text) out.push({ role, text });
    }
    return out;
  }
  // fallback: class 名ベース (旧 UI)
  const fallback = root.querySelectorAll('.font-claude-message, .font-user-message');
  for (const el of fallback) {
    const cls = el.getAttribute('class') ?? '';
    const role: ChatExtractedMessage['role'] = /user/i.test(cls) ? 'user' : 'assistant';
    const text = textOf(el);
    if (text) out.push({ role, text });
  }
  return out;
}

function extractGemini(root: HTMLElement): ChatExtractedMessage[] {
  const out: ChatExtractedMessage[] = [];
  // Gemini UI のカスタム要素タグ user-query / model-response
  const els = root.querySelectorAll('user-query, model-response');
  for (const el of els) {
    const tag = (el.tagName ?? '').toLowerCase();
    const role: ChatExtractedMessage['role'] = tag === 'model-response' ? 'assistant' : 'user';
    const text = textOf(el);
    if (text) out.push({ role, text });
  }
  if (out.length > 0) return out;
  // fallback: 公開 share ページ等は構造が違う可能性 → message-content / response-container を試す
  const fallback = root.querySelectorAll('[data-test-id*="response"], [data-test-id*="user"], .conversation-turn');
  for (const el of fallback) {
    const id = el.getAttribute('data-test-id') ?? '';
    const cls = el.getAttribute('class') ?? '';
    const role: ChatExtractedMessage['role'] = /user/i.test(id) || /user/i.test(cls) ? 'user' : 'assistant';
    const text = textOf(el);
    if (text) out.push({ role, text });
  }
  return out;
}

export function extractChatTitle(html: string): string {
  const root = parseHtml(html);
  const t = root.querySelector('title');
  return (t?.textContent ?? '').trim();
}
