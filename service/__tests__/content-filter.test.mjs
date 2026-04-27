import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkContent, resetFilterCache } from '../content-filter.js';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'memoria-cf-'));
  resetFilterCache();
  delete process.env.MEMORIA_NGWORDS_FILE;
  delete process.env.MEMORIA_NG_DOMAINS_FILE;
  delete process.env.MEMORIA_WHITELIST_FILE;
  delete process.env.MEMORIA_CONTENT_FILTER;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  resetFilterCache();
});

describe('content-filter', () => {
  it('passes a clean bookmark', () => {
    const r = checkContent({
      url: 'https://example.com/article',
      title: 'Normal article',
      html: '<html><body>nothing weird</body></html>',
    });
    expect(r.ok).toBe(true);
  });

  it('blocks a default NG word in title', () => {
    const r = checkContent({
      url: 'https://example.com/x',
      title: 'アダルト動画まとめ',
      html: '<html></html>',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ng_word_in_url_or_title');
    expect(r.matches).toContain('アダルト');
  });

  it('blocks a default NG domain', () => {
    const r = checkContent({ url: 'https://pornhub.com/anything', title: 'x', html: '' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blocked_domain');
  });

  it('supports a regex pattern via re: prefix', () => {
    const file = join(tmpDir, 'ng.txt');
    // Catch ID-shaped tracker tokens anywhere in URL/title.
    writeFileSync(file, 're:secret-[0-9]+\n', 'utf8');
    process.env.MEMORIA_NGWORDS_FILE = file;
    resetFilterCache();
    const blocked = checkContent({
      url: 'https://example.com/path?ref=secret-12345',
      title: 'page',
      html: '<html></html>',
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.matches.some((m) => m.startsWith('re:'))).toBe(true);
    // Non-matching URL still passes.
    const ok = checkContent({
      url: 'https://example.com/normal',
      title: 'page',
      html: '<html></html>',
    });
    expect(ok.ok).toBe(true);
  });

  it('whitelist short-circuits a NG word', () => {
    const file = join(tmpDir, 'wl.txt');
    writeFileSync(file, 'アダルト水泳教室\n', 'utf8');
    process.env.MEMORIA_WHITELIST_FILE = file;
    resetFilterCache();
    const r = checkContent({
      url: 'https://example.com/swim',
      title: 'アダルト水泳教室',
      html: '<html></html>',
    });
    expect(r.ok).toBe(true);
    expect(r.whitelisted).toBe('アダルト水泳教室');
  });

  it('disabled filter passes everything', () => {
    process.env.MEMORIA_CONTENT_FILTER = '0';
    resetFilterCache();
    const r = checkContent({
      url: 'https://pornhub.com/anything',
      title: 'アダルト',
      html: '<html><body>cp porn</body></html>',
    });
    expect(r.ok).toBe(true);
  });
});
