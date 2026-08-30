import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanR18Content } from './r18-content.js';

test('日本語と英語の明示的な成人向け表現を検出する', () => {
  assert.equal(scanR18Content({ body: '成人向けコンテンツ' }).length, 1);
  assert.equal(scanR18Content({ body: 'NSFW material' }).length, 1);
});

test('一般的な技術記事は検出しない', () => {
  assert.deepEqual(scanR18Content({ body: 'Node.js のテスト設計' }), []);
});
