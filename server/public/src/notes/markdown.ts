// Minimal markdown inline → HTML.
//
// 対応:
//   **bold** *italic* `code` [text](url)
//   既に HTML (allowlisted) が混ざっている場合はそのまま (sanitize で処理)
//
// 行レベル (heading / list / quote / code fence) は処理しない — それらは
// block_type 側で決まる。 この関数は 1 ブロック分の inline span を扱う。

import { escapeHtml } from './sanitize.js';

export function renderInline(text: string): string {
  if (!text) return '';
  // 既存 HTML タグはそのまま、それ以外は escape する。
  // パース手法: 連続 HTML タグ / マークダウンランをトークン化 → render
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '<') {
      // HTML タグ (allowlisted) — 閉じタグまでスキップ。
      const end = text.indexOf('>', i);
      if (end < 0) { parts.push(escapeHtml(text.slice(i))); break; }
      parts.push(text.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    if (c === '`') {
      // inline code: from ` to next `
      const end = text.indexOf('`', i + 1);
      if (end < 0) { parts.push(escapeHtml(c)); i++; continue; }
      parts.push(`<code>${escapeHtml(text.slice(i + 1, end))}</code>`);
      i = end + 1;
      continue;
    }
    if (c === '*') {
      // **bold** or *italic*
      if (text[i + 1] === '*') {
        const end = text.indexOf('**', i + 2);
        if (end > 0) {
          parts.push(`<b>${renderInline(text.slice(i + 2, end))}</b>`);
          i = end + 2;
          continue;
        }
      } else {
        const end = text.indexOf('*', i + 1);
        if (end > 0) {
          parts.push(`<i>${renderInline(text.slice(i + 1, end))}</i>`);
          i = end + 1;
          continue;
        }
      }
    }
    if (c === '[') {
      // [text](url)
      const close = text.indexOf(']', i + 1);
      if (close > 0 && text[close + 1] === '(') {
        const urlEnd = text.indexOf(')', close + 2);
        if (urlEnd > 0) {
          const inner = text.slice(i + 1, close);
          const url = text.slice(close + 2, urlEnd);
          if (/^(https?:|mailto:|\/|#)/i.test(url)) {
            parts.push(`<a href="${escapeHtml(url)}" rel="noopener noreferrer" target="_blank">${escapeHtml(inner)}</a>`);
            i = urlEnd + 1;
            continue;
          }
        }
      }
    }
    // plain text — escape
    parts.push(escapeHtml(c));
    i++;
  }
  return parts.join('');
}
