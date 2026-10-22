// Run with: node --import tsx --test public/markdown-boundary.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderInline } from './src/shared/markdown.ts';
import { renderMarkdownBlock } from './src/markdown-block.ts';

const hostile = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<div><img src=x onerror=alert(1)></div>',
  '<span><a href="javascript:alert(1)">click</a></span>',
  '<svg><a xlink:href="javascript:alert(1)">click</a></svg>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<a href="jav&#x61;script:alert(1)" onclick="alert(1)">click</a>',
  '</p><img src=x onerror=alert(1)><p>',
  '<!-- comment --><object data="data:text/html,attack"></object>',
];

test('inline Markdown renders raw HTML literally, even in nested decorations', () => {
  for (const payload of hostile) {
    assert.doesNotMatch(renderInline(payload), /[<>]/);
    assert.doesNotMatch(renderInline(`**${payload}**`).replace(/<\/?b>/g, ''), /[<>]/);
    assert.doesNotMatch(renderInline(`*${payload}*`).replace(/<\/?i>/g, ''), /[<>]/);
  }
  assert.equal(renderInline('<b>text</b>'), '&lt;b&gt;text&lt;/b&gt;');
  assert.equal(renderInline('<img'), '&lt;img');
  assert.equal(renderInline('&lt;img src=x onerror=alert(1)&gt;'), '&amp;lt;img src=x onerror=alert(1)&amp;gt;');
});

test('inline formatting, code and allowed links still work', () => {
  assert.equal(renderInline('**bold** *italic* `<img>`'), '<b>bold</b> <i>italic</i> <code>&lt;img&gt;</code>');
  for (const url of ['https://example.com', 'http://example.com', 'mailto:a@example.com', '/local', '#anchor']) {
    assert.equal(renderInline(`[ok](${url})`), `<a href="${url}" rel="noopener noreferrer" target="_blank">ok</a>`);
  }
  for (const url of ['javascript:alert', 'data:text/html,attack', 'vbscript:attack', 'jav&#x61;script:attack']) {
    assert.doesNotMatch(renderInline(`[click](${url})`), /<a\b/);
  }
  assert.match(renderInline('[<img>](https://example.com/?x="attack")'), /&lt;img&gt;<\/a>/);
  assert.match(renderInline('[ok](https://example.com/"onclick="attack)'), /&quot;onclick=&quot;/);
});

test('external diary block rendering escapes hostile HTML in every inline position', () => {
  const contexts = [
    (s) => s, (s) => `# ${s}`, (s) => `> ${s}`, (s) => `- ${s}`,
    (s) => `1. ${s}`, (s) => `| ${s} | safe |\n| --- | --- |\n| safe | ${s} |`,
    (s) => `\`\`\`html\n${s}\n\`\`\``,
  ];
  for (const payload of hostile) {
    for (const context of contexts) {
      const html = renderMarkdownBlock(context(payload));
      assert.doesNotMatch(html, /<(?:script|img|svg|iframe|object|div|span|a)\b/i);
      assert.match(html, /&lt;/);
    }
  }
});

test('block rendering preserves diary headings, lists, tables and code', () => {
  const html = renderMarkdownBlock('# Title\n\n- **bold**\n\n1. *item*\n\n> quote\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```html\n<img>\n```');
  for (const expected of ['<h1 class="md-h1">Title</h1>', '<ul', '<ol', '<blockquote', '<table', '<b>bold</b>', '<i>item</i>', '&lt;img&gt;']) {
    assert.ok(html.includes(expected), expected);
  }
});
