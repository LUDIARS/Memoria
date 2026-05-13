// Block-level markdown → HTML renderer (見出し + テーブル + リスト + 段落 + 引用 + コードフェンス)。
//
// レビュー閲覧 (AIFormat REVIEW_*.md) で使う想定。 ノートの block 編集
// (block_type を DB が持つ) とは別軸で、 ここでは「Markdown ファイル全体を
// 一括で HTML に変換する」 用途。
//
// インライン (**bold**, *italic*, `code`, [text](url)) は notes/markdown.ts の
// renderInline をそのまま流用する。

import { renderInline } from './notes/markdown.js';
import { escapeHtml } from './notes/sanitize.js';

export function renderMarkdownBlock(md: string): string {
  if (!md) return '';
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ─── コードフェンス ``` ───
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
      out.push(`<pre class="md-code"${langAttr}><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    // ─── 見出し # / ## / ... / ###### ───
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level} class="md-h${level}">${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // ─── 水平線 --- / *** ───
    if (/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/.test(line)) {
      out.push('<hr class="md-hr">');
      i++;
      continue;
    }

    // ─── パイプテーブル ───
    // 1 行目: | col1 | col2 |
    // 2 行目: |------|------|  または :----:  / -----:
    if (isPipeTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headerCells = splitTableRow(line);
      const aligns = parseAligns(lines[i + 1]);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && isPipeTableRow(lines[i])) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      out.push(buildTable(headerCells, aligns, bodyRows));
      continue;
    }

    // ─── 引用 > ───
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote class="md-blockquote">${quoteLines.map((l) => renderInline(l)).join('<br>')}</blockquote>`);
      continue;
    }

    // ─── 順序なしリスト - / * / + ───
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push(`<ul class="md-ul">${items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</ul>`);
      continue;
    }

    // ─── 順序付きリスト 1. 2. ───
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push(`<ol class="md-ol">${items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</ol>`);
      continue;
    }

    // ─── 空行 ───
    if (line.trim() === '') { i++; continue; }

    // ─── 段落 (空行 / 別ブロックまで連結) ───
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !(isPipeTableRow(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    out.push(`<p class="md-p">${renderInline(paraLines.join(' '))}</p>`);
  }

  return out.join('\n');
}

// ─── table helpers ────────────────────────────────────────────────────────

function isPipeTableRow(line: string): boolean {
  // 少なくとも 1 つの `|` を内側に含む行 (= cell が 2 つ以上)。
  // 例: `| a | b |` / `a | b` / `| a |`
  if (!line.includes('|')) return false;
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.includes('|');
}

function isTableSeparator(line: string): boolean {
  // 全 cell が `:?-+:?` 形式 (空白可) であること。
  if (!isPipeTableRow(line)) return false;
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-{3,}:?$/.test(c.trim()) || /^:?-+:?$/.test(c.trim()));
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function parseAligns(sep: string): ('left' | 'center' | 'right' | null)[] {
  return splitTableRow(sep).map((c) => {
    const t = c.trim();
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

function buildTable(
  header: string[],
  aligns: ('left' | 'center' | 'right' | null)[],
  body: string[][],
): string {
  const head = `<thead><tr>${header.map((h, i) => {
    const a = aligns[i] ? ` style="text-align:${aligns[i]}"` : '';
    return `<th${a}>${renderInline(h)}</th>`;
  }).join('')}</tr></thead>`;
  const cols = header.length;
  const bodyHtml = body.map((row) => {
    // セル数が足りない / 多い場合は padding / 打ち切り
    const cells = row.slice(0, cols);
    while (cells.length < cols) cells.push('');
    return `<tr>${cells.map((c, i) => {
      const a = aligns[i] ? ` style="text-align:${aligns[i]}"` : '';
      return `<td${a}>${renderInline(c)}</td>`;
    }).join('')}</tr>`;
  }).join('');
  return `<table class="md-table">${head}<tbody>${bodyHtml}</tbody></table>`;
}
