// Browser module tests run under tsx, outside the backend TypeScript program.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderDevThroughput } from '../public/src/dev-throughput-view.ts';

test('code additions view distinguishes unknown days from zero and averages only known days', () => {
  const html = renderDevThroughput({
    days: [null, 0, 12].map((codeAdditions, index) => ({ day: `2026-10-${14 - index}`, rvMerged: 0, rvByRepo: {}, commits: 1, codeAdditions })),
    sync: { running: false, lastFinishedAt: null, lastError: null },
  });
  assert.match(html, /コード追加 12 行/);
  assert.match(html, /集計済み 2 日・1 日平均 6.0 行/);
  assert.match(html, /コード追加行数/);
});
