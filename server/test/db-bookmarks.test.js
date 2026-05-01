import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../db.js';
import {
  insertBookmark,
  findBookmarkByUrl,
  getBookmark,
  setSummary,
  listBookmarks,
  countBookmarks,
  updateMemoAndCategories,
  deleteBookmark,
  recordAccess,
  listAccesses,
  listAllCategories,
} from '../db/bookmarks.js';

describe('db/bookmarks', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db.close(); });

  it('insert + findByUrl + getBookmark', () => {
    const id = insertBookmark(db, { url: 'https://example.com', title: 'Ex', htmlPath: 'h/x.html' });
    expect(typeof id).toBe('number');
    const found = findBookmarkByUrl(db, 'https://example.com');
    expect(found.id).toBe(id);
    expect(found.title).toBe('Ex');
    const got = getBookmark(db, id);
    expect(got.url).toBe('https://example.com');
    expect(got.categories).toEqual([]);
  });

  it('setSummary writes summary + categories', () => {
    const id = insertBookmark(db, { url: 'https://a.b/c', title: 't', htmlPath: 'h.html' });
    setSummary(db, id, { summary: 'hello', categories: ['tech', 'tools'], status: 'done', error: null });
    const got = getBookmark(db, id);
    expect(got.summary).toBe('hello');
    expect(got.status).toBe('done');
    expect(got.categories.sort()).toEqual(['tech', 'tools']);
  });

  it('list / count with filter and pagination', () => {
    for (let i = 0; i < 5; i++) {
      const id = insertBookmark(db, { url: `https://x.test/${i}`, title: `Title ${i}`, htmlPath: `h${i}.html` });
      setSummary(db, id, { summary: `s${i}`, categories: i % 2 === 0 ? ['even'] : ['odd'], status: 'done', error: null });
    }
    expect(countBookmarks(db, {})).toBe(5);
    expect(countBookmarks(db, { category: 'even' })).toBe(3);

    const evens = listBookmarks(db, { category: 'even' });
    expect(evens.length).toBe(3);
    expect(evens.every(b => b.categories.includes('even'))).toBe(true);

    const page = listBookmarks(db, { limit: 2, offset: 0, sort: 'created_asc' });
    expect(page.length).toBe(2);
    const allCats = listAllCategories(db);
    expect(allCats.find(c => c.category === 'even').count).toBe(3);
  });

  it('search via q parameter (LIKE)', () => {
    insertBookmark(db, { url: 'https://a.test/x', title: 'apple', htmlPath: 'h1' });
    insertBookmark(db, { url: 'https://b.test/y', title: 'banana', htmlPath: 'h2' });
    const r = listBookmarks(db, { q: 'apple' });
    expect(r.length).toBe(1);
    expect(r[0].title).toBe('apple');
  });

  it('updateMemoAndCategories overrides existing categories', () => {
    const id = insertBookmark(db, { url: 'https://t/u', title: 't', htmlPath: 'h' });
    setSummary(db, id, { summary: '', categories: ['old'], status: 'done', error: null });
    updateMemoAndCategories(db, id, { memo: 'note', categories: ['new1', 'new2'] });
    const got = getBookmark(db, id);
    expect(got.memo).toBe('note');
    expect(got.categories.sort()).toEqual(['new1', 'new2']);
  });

  it('deleteBookmark cascades categories + accesses', () => {
    const id = insertBookmark(db, { url: 'https://x', title: 'x', htmlPath: 'h' });
    setSummary(db, id, { summary: '', categories: ['c'], status: 'done', error: null });
    recordAccess(db, id);
    expect(listAccesses(db, id, 10).length).toBe(1);
    deleteBookmark(db, id);
    expect(getBookmark(db, id)).toBeNull();
  });
});
