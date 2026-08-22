import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGithubRepo, releaseWatchConfigSchema, DEFAULT_RELEASE_WATCH_CONFIG } from './config.js';
import { fetchGithubReleases, fetchGithubTags, normalizeGithubReleases, renderNotesUrl } from './github-source.js';
import { coerceExtractedReleases } from './html-source.js';
import { extractJsonArray } from './llm-json.js';
import { parseReleaseFeed } from './rss-source.js';
import type { ReleaseSource } from './types.js';

const base: ReleaseSource = {
  id: 'x', name: 'X', kind: 'github_releases', url: 'https://github.com/acme/tool',
  notesUrlTemplate: null, includePattern: null, enabled: true,
};

test('既定設定はスキーマを通る', () => {
  assert.equal(releaseWatchConfigSchema.safeParse(DEFAULT_RELEASE_WATCH_CONFIG).success, true);
});

test('GitHub 種類は github.com のリポジトリ URL 以外を拒否する', () => {
  const bad = { ...DEFAULT_RELEASE_WATCH_CONFIG, sources: [{ ...base, url: 'https://example.com/acme/tool' }] };
  assert.equal(releaseWatchConfigSchema.safeParse(bad).success, false);
  assert.deepEqual(parseGithubRepo('https://github.com/git/git.git'), { owner: 'git', repo: 'git' });
  assert.equal(parseGithubRepo('https://github.com/git'), null);
});

test('壊れた正規表現は設定として拒否する', () => {
  const bad = { ...DEFAULT_RELEASE_WATCH_CONFIG, sources: [{ ...base, includePattern: '(' }] };
  assert.equal(releaseWatchConfigSchema.safeParse(bad).success, false);
});

test('GitHub Releases は draft を除き includePattern で絞る', () => {
  const json = [
    { tag_name: 'v2.0.0', html_url: 'https://github.com/acme/tool/releases/tag/v2.0.0', published_at: '2026-08-01T00:00:00Z', body: 'b' },
    { tag_name: 'v1.9.0-rc1', html_url: 'https://github.com/acme/tool/releases/tag/v1.9.0-rc1', body: '' },
    { tag_name: 'v1.8.0', html_url: 'https://github.com/acme/tool/releases/tag/v1.8.0', draft: true },
  ];
  const out = normalizeGithubReleases({ ...base, includePattern: '^v\\d+\\.\\d+\\.\\d+$' }, json);
  assert.deepEqual(out.map((r) => r.version), ['v2.0.0']);
  assert.equal(out[0].publishedAt, '2026-08-01T00:00:00Z');
});

test('fetchGithubReleases は API URL を組み立て limit 件に切る', async () => {
  const calls: string[] = [];
  const out = await fetchGithubReleases(base, 2, async (url) => {
    calls.push(url);
    return { text: JSON.stringify([1, 2, 3].map((n) => ({ tag_name: `v${n}`, html_url: `https://github.com/acme/tool/releases/tag/v${n}` }))) };
  });
  assert.match(calls[0], /^https:\/\/api\.github\.com\/repos\/acme\/tool\/releases\?per_page=\d+$/);
  assert.equal(out.length, 2);
});

test('GitHub タグ種類はテンプレからリリースノートを取りに行き、 失敗しても版を落とさない', async () => {
  const source: ReleaseSource = {
    ...base, kind: 'github_tags', includePattern: '^v\\d+\\.\\d+\\.\\d+$',
    notesUrlTemplate: 'https://raw.example.com/{tag}/RelNotes/{version}.txt',
  };
  const out = await fetchGithubTags(source, 5, async (url) => {
    if (url.includes('/tags')) return { text: JSON.stringify([{ name: 'v2.1.0' }, { name: 'v2.1.0-rc0' }, { name: 'v2.0.0' }]) };
    if (url.endsWith('/v2.1.0/RelNotes/2.1.0.txt')) return { text: 'notes 2.1.0' };
    throw new Error('HTTP 404');
  });
  assert.deepEqual(out.map((r) => r.version), ['v2.1.0', 'v2.0.0']);
  assert.equal(out[0].body, 'notes 2.1.0');
  assert.match(out[1].body, /release notes unavailable/);
  assert.equal(renderNotesUrl('https://x/{tag}/{version}', 'v1.2.3'), 'https://x/v1.2.3/1.2.3');
});

test('RSS 2.0 と Atom を同じ形に正規化する', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
    <item><title><![CDATA[Unity 6000.2.5f1]]></title><link>https://unity.com/r/1</link><pubDate>Tue, 18 Aug 2026 00:00:00 GMT</pubDate><description><![CDATA[<p>Fixed <b>stuff</b></p>]]></description></item>
    <item><title>Unity 6000.0.60f1</title><link>https://unity.com/r/2</link></item>
  </channel></rss>`;
  const fromRss = parseReleaseFeed({ ...base, kind: 'rss', url: 'https://unity.com/feed.xml' }, rss);
  assert.equal(fromRss.length, 2);
  assert.equal(fromRss[0].version, 'Unity 6000.2.5f1');
  assert.equal(fromRss[0].body, 'Fixed stuff');
  assert.equal(fromRss[0].publishedAt, '2026-08-18T00:00:00.000Z');

  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>v3.0.0</title>
    <link rel="alternate" href="https://example.com/v3"/><updated>2026-08-10T00:00:00Z</updated><content type="html">&lt;ul&gt;&lt;li&gt;new&lt;/li&gt;&lt;/ul&gt;</content></entry></feed>`;
  const fromAtom = parseReleaseFeed({ ...base, kind: 'rss', url: 'https://example.com/feed' }, atom);
  assert.equal(fromAtom[0].url, 'https://example.com/v3');
  assert.equal(fromAtom[0].body, 'new');
});

test('エンティティ復号は 1 回だけ (二重復号でタグが復活しない)', async () => {
  const { stripHtml } = await import('./rss-source.js');
  // `&amp;lt;div&amp;gt;` は「本文に literal な <div> を見せたい」表現。 復号後は文字列のまま残す。
  assert.equal(stripHtml('<p>Use &amp;lt;div&amp;gt; in code</p>'), 'Use &lt;div&gt; in code');
  assert.equal(stripHtml('&amp;lt;img src=x onerror=1&amp;gt;'), '&lt;img src=x onerror=1&gt;');
  // 通常の 1 段エンティティ化された HTML は従来どおりタグが落ちる。
  assert.equal(stripHtml('&lt;ul&gt;&lt;li&gt;new&lt;/li&gt;&lt;/ul&gt;'), 'new');
});

test('XML でないものは feed エラーになる', () => {
  assert.throws(() => parseReleaseFeed({ ...base, kind: 'rss' }, '<html><body>nope</body></html>'), /neither RSS nor Atom/);
});

test('LLM 抽出 JSON はコードフェンス付きでも拾い、 相対 URL はページ基準に解決する', () => {
  const raw = '以下です\n```json\n[{"version":"5.6","url":"/docs/5-6","publishedAt":"2026-06-01","body":"x"},{"version":"","body":""},{"version":"5.5","url":"javascript:alert(1)"}]\n```';
  const out = coerceExtractedReleases({ ...base, kind: 'html', url: 'https://dev.example.com/ue/notes' }, extractJsonArray(raw));
  assert.deepEqual(out.map((r) => [r.version, r.url]), [
    ['5.6', 'https://dev.example.com/docs/5-6'],
    ['5.5', 'https://dev.example.com/ue/notes'],
  ]);
  assert.deepEqual(extractJsonArray('not json'), []);
});

test('RSS 本文がタイトル程度なら releaseNotesLink を取りに行って本文にする', async () => {
  const { fetchRssReleases } = await import('./rss-source.js');
  const rss = `<rss version="2.0"><channel><item><title>Unity 6000.0.82f1 LTS</title><description>Unity 6000.0.82f1 LTS</description>
    <link>https://unity.com/releases/editor/whats-new/6000.0.82f1</link><releaseNotesLink>https://storage.example.com/6000_0_82f1.md</releaseNotesLink></item></channel></rss>`;
  const calls: string[] = [];
  const out = await fetchRssReleases({ ...base, kind: 'rss', url: 'https://unity.com/feed.xml' }, 5, async (url) => {
    calls.push(url);
    if (url.endsWith('feed.xml')) return { text: rss };
    return { text: '# 6000.0.82f1\n\n## Fixes\n- Editor: crash fixed' };
  });
  assert.deepEqual(calls, ['https://unity.com/feed.xml', 'https://storage.example.com/6000_0_82f1.md']);
  assert.match(out[0].body, /crash fixed/);
  assert.equal(out[0].url, 'https://unity.com/releases/editor/whats-new/6000.0.82f1');
});
