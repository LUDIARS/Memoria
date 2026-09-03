// サジェストの純粋部分 (プロンプト・出力パース・マージ) のテスト。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { DEFAULT_BOOKS_CONFIG } from './config.js';
import { ensureBooksSchema } from './schema.js';
import { buildSuggestPrompt, parseSuggestOutput } from './suggest-prompt.js';
import { generateSuggestions, mergeDrafts } from './suggest.js';
import type { Book, BookCandidate } from './types.js';
import { replaceSuggestions, type SuggestionDraft } from './store.js';

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: 1, isbn13: null, asin: null, title: '良かった本', authors: ['著者A'], publisher: null,
    series: null, publishedOn: null, rating: 5, review: 'よかった', tags: ['SF'], readOn: null,
    coverUrl: null, source: 'manual', createdAt: '', updatedAt: '', ...overrides,
  };
}

function candidate(title: string, overrides: Partial<BookCandidate> = {}): BookCandidate {
  return {
    isbn13: null, title, authors: ['著者A'], publisher: null, series: null, publishedOn: null,
    coverUrl: null, url: null, source: 'google_books', rating: null, ratingCount: null,
    salesRank: null, ...overrides,
  };
}

function draft(title: string, score: number, origin: SuggestionDraft['origin'] = 'llm'): SuggestionDraft {
  return { candidate: candidate(title), origin, reason: 'r', score };
}

test('プロンプトに良かった本と既読リストが両方入る', () => {
  const prompt = buildSuggestPrompt([book()], [book({ title: '既読の本' })], 5);
  assert.match(prompt, /良かった本/);
  assert.match(prompt, /★5/);
  assert.match(prompt, /既読の本/);
  assert.match(prompt, /5 冊/);
});

test('コードフェンス付き・前置き付きの出力から JSON を取り出す', () => {
  const raw = 'はい、こちらです。\n```json\n[{"title":"本A","author":"著者A","reason":"理由"}]\n```';
  assert.deepEqual(parseSuggestOutput(raw), [{ title: '本A', author: '著者A', reason: '理由' }]);
});

test('title の無い要素と壊れた出力は捨てる', () => {
  assert.deepEqual(parseSuggestOutput('[{"author":"x"}]'), []);
  assert.deepEqual(parseSuggestOutput('壊れています'), []);
});

test('mergeDrafts は所持済み・ブロック済みを除き、 同じ本は高スコア側を採る', () => {
  const merged = mergeDrafts([
    draft('本A', 1.0),
    draft('本A', 1.4, 'rakuten_ranking'),
    draft('持ってる本', 2.0),
    draft('嫌いな本', 2.0),
    draft('本B', 0.9),
  ], new Set(['持ってる本']), new Set(['嫌いな本']), 10);

  assert.deepEqual(merged.map((d) => d.candidate.title), ['本A', '本B']);
  assert.equal(merged[0].origin, 'rakuten_ranking');
});

test('mergeDrafts は件数上限で切る', () => {
  const merged = mergeDrafts([draft('1', 3), draft('2', 2), draft('3', 1)], new Set(), new Set(), 2);
  assert.deepEqual(merged.map((d) => d.candidate.title), ['1', '2']);
});

test('一時的な生成失敗で前回のサジェストを消さない', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  ensureBooksSchema(db);
  replaceSuggestions(db, [draft('前回の候補', 1)]);

  const result = await generateSuggestions(db, DEFAULT_BOOKS_CONFIG, new Date('2026-09-03T09:00:00'), {
    runLlm: async () => { throw new Error('offline'); },
  });

  assert.deepEqual(result.suggestions.map((suggestion) => suggestion.title), ['前回の候補']);
  assert.equal(result.errors.length, 1);
});

test('実在確認ソースが無効なら LLM に読書データを送らない', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  ensureBooksSchema(db);
  let called = false;

  await generateSuggestions(db, {
    ...DEFAULT_BOOKS_CONFIG,
    sources: { googleBooks: false, openbd: false, ndl: false, rakuten: false },
  }, new Date('2026-09-03T09:00:00'), {
    runLlm: async () => { called = true; return '[]'; },
  });

  assert.equal(called, false);
});
