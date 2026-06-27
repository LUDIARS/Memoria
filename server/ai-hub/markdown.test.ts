// articleToMarkdown のユニットテスト (node:test)。
// frontmatter / 本文の H1 再付与 / 出所セクション / ファイル名 slug を検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articleToMarkdown } from './markdown.js';
import type { AiArticle } from './types.js';

function makeArticle(over: Partial<AiArticle> = {}): AiArticle {
  return {
    id: 42,
    title: 'TDZ で死ぬ const',
    body_md: '本文の 1 行目。\n\n## 節\n中身。',
    topic_key: null,
    source_refs: [],
    origin: 'digest',
    for_date: '2026-06-27',
    tags: [],
    note_id: null,
    created_at: '2026-06-27T01:23:45.000Z',
    ...over,
  };
}

test('frontmatter に title/date/origin/source を含む', () => {
  const { content } = articleToMarkdown(makeArticle());
  assert.match(content, /^---\n/);
  assert.match(content, /title: "TDZ で死ぬ const"/);
  assert.match(content, /date: 2026-06-27/);
  assert.match(content, /origin: "digest"/);
  assert.match(content, /source: "Memoria AI記事 #42"/);
});

test('body_md の前に H1 タイトルを再付与する', () => {
  const { content } = articleToMarkdown(makeArticle());
  assert.match(content, /\n# TDZ で死ぬ const\n\n本文の 1 行目。/);
});

test('tags があれば YAML リストで出力する', () => {
  const { content } = articleToMarkdown(makeArticle({
    tags: [{ category: '言語', value: 'TypeScript' }, { category: 'プロジェクト', value: 'Memoria' }],
  }));
  assert.match(content, /tags:\n  - "TypeScript"\n  - "Memoria"/);
});

test('source_refs があれば末尾に出所セクションを足す', () => {
  const { content } = articleToMarkdown(makeArticle({
    source_refs: [{ kind: 'git_commit', ref: 'abc123', repo: 'Memoria' }],
  }));
  assert.match(content, /## 出所\n\n- Memoria · git_commit · abc123\n/);
});

test('source_refs が空なら出所セクションは出さない', () => {
  const { content } = articleToMarkdown(makeArticle({ source_refs: [] }));
  assert.doesNotMatch(content, /## 出所/);
});

test('ファイル名は date- + slug.md、 パス禁止文字は除去', () => {
  const { filename } = articleToMarkdown(makeArticle({ title: 'a/b:c?d 記事' }));
  assert.equal(filename, '2026-06-27-a-b-c-d-記事.md');
});

test('for_date が無ければ created_at の日付を使う', () => {
  const { content, filename } = articleToMarkdown(makeArticle({ for_date: null }));
  assert.match(content, /date: 2026-06-27/);
  assert.match(filename, /^2026-06-27-/);
});

test('title が空なら無題 + ai-article-<id>.md', () => {
  const { content, filename } = articleToMarkdown(makeArticle({ title: '', for_date: null, created_at: '' }));
  assert.match(content, /title: "無題"/);
  assert.equal(filename, 'ai-article-42.md');
});

test('YAML の二重引用符をエスケープする', () => {
  const { content } = articleToMarkdown(makeArticle({ title: '"quoted" タイトル' }));
  assert.match(content, /title: "\\"quoted\\" タイトル"/);
});
