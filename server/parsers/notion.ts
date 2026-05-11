// Notion extractor — 保存済 HTML から Notion ブロック構造を抽出する。
//
// extension/content.js の extractNotionTitle / extractNotionPageId /
// extractNotionBlocks をサーバ側で再現したもの。

import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import type { NotionExtractedBlock } from '../api/types/note.js';

export function isNotionUrl(url: string): boolean {
  if (!url) return false;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return host.endsWith('notion.so') || host.endsWith('notion.site');
}

export function extractNotionTitle(html: string): string {
  const root = parseHtml(html);
  const t = root.querySelector('h1.notion-page-title-text')
    ?? root.querySelector('[placeholder="Untitled"]')
    ?? root.querySelector('title');
  return ((t?.textContent ?? '').trim()) || '';
}

export function extractNotionPageId(url: string): string | null {
  const m = url.match(/([0-9a-f]{32})/i);
  return m ? m[1] : null;
}

export function extractNotionBlocks(html: string): NotionExtractedBlock[] {
  const root = parseHtml(html, { lowerCaseTagName: false });
  const blocks: NotionExtractedBlock[] = [];
  const container = root.querySelector('.notion-page-content')
    ?? root.querySelector('main')
    ?? root;

  const els = container.querySelectorAll('[data-block-id]');
  for (const el of els) {
    const cls = el.getAttribute('class') ?? '';

    // contenteditable 内のテキストを優先 (Notion は contenteditable=true がブロック本文)
    const editable = el.querySelector('[contenteditable="true"]');
    const text = ((editable?.textContent ?? el.textContent ?? '')).trim();

    if (cls.includes('notion-bookmark-block')) {
      const a = el.querySelector('a[href]');
      const url = a ? (a.getAttribute('href') ?? '') : '';
      if (!url) continue;
      const titleEl = findByClassFragment(el, 'bookmark-title');
      const captionEl = findByClassFragment(el, 'bookmark-description');
      const img = el.querySelector('img');
      blocks.push({
        kind: 'bookmark',
        url,
        title: (titleEl?.textContent ?? '').trim(),
        caption: (captionEl?.textContent ?? '').trim(),
        image: img ? (img.getAttribute('src') ?? '') : '',
      });
      continue;
    }

    if (cls.includes('notion-divider-block')) {
      blocks.push({ kind: 'divider' });
      continue;
    }

    let kind: NotionExtractedBlock['kind'] | null = null;
    if (cls.includes('notion-header-block')) kind = 'heading_1';
    else if (cls.includes('notion-sub_header-block')) kind = 'heading_2';
    else if (cls.includes('notion-sub_sub_header-block')) kind = 'heading_3';
    else if (cls.includes('notion-quote-block')) kind = 'quote';
    else if (cls.includes('notion-bulleted_list-block')) kind = 'bullet_list';
    else if (cls.includes('notion-numbered_list-block')) kind = 'numbered_list';
    else if (cls.includes('notion-code-block')) kind = 'code';
    else if (cls.includes('notion-text-block')) kind = 'text';
    else if (cls.includes('notion-to_do-block')) {
      const cb = el.querySelector('input[type="checkbox"]');
      const checked = cb ? cb.getAttribute('checked') !== null : false;
      if (!text) continue;
      blocks.push({ kind: 'todo', text, checked });
      continue;
    }

    if (!kind) continue;
    if (!text) continue;
    if (kind === 'heading_1' || kind === 'heading_2' || kind === 'heading_3'
      || kind === 'text' || kind === 'quote') {
      blocks.push({ kind, text });
    } else if (kind === 'bullet_list' || kind === 'numbered_list') {
      blocks.push({ kind, text });
    } else if (kind === 'code') {
      blocks.push({ kind, text });
    }
  }
  return blocks;
}

/** className に「特定の文字列を含む」 子孫を探す (Notion の生成 class hash 付き対策)。 */
function findByClassFragment(scope: HTMLElement, fragment: string): HTMLElement | null {
  const all = scope.querySelectorAll('*');
  for (const el of all) {
    const cls = el.getAttribute('class') ?? '';
    if (cls.includes(fragment)) return el;
  }
  return null;
}
