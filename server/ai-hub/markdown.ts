// ai-hub — AiArticle を 1 本の Markdown ファイル (.md) に書き出す。
// エクスポート md のフォーマットをここ 1 箇所に集約する (route / 将来の一括出力で共用)。
// Spec: spec/feature/ai-hub.md §API (GET /api/ai/articles/:id/export.md)

import type { AiArticle, SourceRef } from './types.js';

/** YAML 値として安全な二重引用符文字列にする (\ と " をエスケープ)。 */
function yamlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** ISO / 日付文字列から YYYY-MM-DD 部分を取り出す。 取れなければ空文字。 */
function dateOnly(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso.trim());
  return m ? m[1] : '';
}

/** 制御文字 (U+0000..U+001F と U+007F) を空白に置き換える。 */
function stripControlChars(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    out += (code < 0x20 || code === 0x7f) ? ' ' : ch;
  }
  return out;
}

/** source_ref 1 件を人間可読な 1 行に (repo · kind · ref)。 */
function sourceRefLine(r: SourceRef): string {
  return [r.repo, r.kind, r.ref].map((x) => (x ?? '').toString().trim()).filter(Boolean).join(' · ') || 'source';
}

/**
 * ファイル名用 slug。 パス禁止文字・制御文字を除去し、 空白を `-` に畳む。
 * 日本語はそのまま残す (UTF-8 ファイル名)。 長すぎる場合は 60 文字で切る。
 */
function slugifyTitle(title: string): string {
  const cleaned = stripControlChars(title.replace(/[\\/:*?"<>|]/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ /g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.slice(0, 60).replace(/-+$/g, '');
}

export interface MarkdownExport {
  /** 推奨ファイル名 (例: 2026-06-27-記事タイトル.md)。 */
  filename: string;
  /** .md 本文 (YAML frontmatter + 本文 + 出所)。 */
  content: string;
}

/**
 * AiArticle を frontmatter 付き Markdown に変換する。
 *
 * - frontmatter: title / date(=for_date 優先, 無ければ created_at の日付) / origin / tags(値の配列)。
 * - 本文: body_md は H1 タイトルが除去済み (generator.parseMarkdownArticle) のため `# title` を再付与する。
 * - 出所: source_refs があれば末尾に「## 出所」 セクションを足す。
 */
export function articleToMarkdown(article: AiArticle): MarkdownExport {
  const date = dateOnly(article.for_date) || dateOnly(article.created_at);

  const fm: string[] = ['---'];
  fm.push(`title: ${yamlString(article.title || '無題')}`);
  if (date) fm.push(`date: ${date}`);
  if (article.origin) fm.push(`origin: ${yamlString(article.origin)}`);
  if (article.tags && article.tags.length) {
    fm.push('tags:');
    for (const t of article.tags) fm.push(`  - ${yamlString(t.value)}`);
  }
  fm.push(`source: ${yamlString(`Memoria AI記事 #${article.id}`)}`);
  fm.push('---');

  const parts: string[] = [fm.join('\n'), '', `# ${article.title || '無題'}`, '', (article.body_md || '').trim()];

  if (article.source_refs && article.source_refs.length) {
    parts.push('', '---', '', '## 出所', '');
    for (const r of article.source_refs) parts.push(`- ${sourceRefLine(r)}`);
  }

  const content = parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  const slug = slugifyTitle(article.title || '') || `ai-article-${article.id}`;
  const filename = `${date ? `${date}-` : ''}${slug}.md`;

  return { filename, content };
}
