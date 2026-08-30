import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNotionTransfer } from './notion-transfer-check.js';

test('全検査を title/body_md に適用し、一致があれば転送不可にする', () => {
  const result = checkNotionTransfer({
    id: 7,
    title: 'InternalProject の記録',
    body_md: '連絡先は person@example.com。成人向けの内容を含む。',
  }, ['InternalProject']);

  assert.equal(result.transferable, false);
  assert.deepEqual(
    [...new Set(result.findings.map((finding) => finding.check))].sort(),
    ['r18', 'redaction', 'sensitive-content'],
  );
});

test('一致がなければ転送可能にする', () => {
  const result = checkNotionTransfer({
    id: 8,
    title: 'TypeScript の型設計',
    body_md: '判別可能 union の設計を解説する。',
  }, ['InternalProject']);

  assert.equal(result.transferable, true);
  assert.deepEqual(result.findings, []);
});
