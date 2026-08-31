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

test('制限案件の source_refs と本文別名を転送不可にする', () => {
  const sourceResult = checkNotionTransfer({
    id: 9,
    title: 'プロジェクトの記録',
    body_md: '一般化した設計メモ。',
    source_refs: JSON.stringify([{
      kind: 'git_commit',
      ref: 'abc123',
      repo: 'https://example.invalid/LUDIARS/MakaiNui.git',
    }]),
  }, []);
  const mentionResult = checkNotionTransfer({
    id: 10,
    title: '設計メモ',
    body_md: 'KS 案件の作業記録。',
  }, []);

  assert.equal(sourceResult.transferable, false);
  assert.equal(sourceResult.findings[0]?.rule, 'restricted-project-source');
  assert.equal(mentionResult.transferable, false);
  assert.equal(mentionResult.findings[0]?.rule, 'restricted-project-mention');
});

test('空文字または構造不正の source_refs を fail-closed で転送不可にする', () => {
  for (const [id, source_refs] of [
    [11, ''],
    [12, '{not-json'],
    [13, JSON.stringify([{ repo: 'Memoria' }])],
  ] as const) {
    const result = checkNotionTransfer({
      id,
      title: '設計メモ',
      body_md: '一般化した内容。',
      source_refs,
    }, []);

    assert.equal(result.transferable, false);
    assert.equal(result.findings[0]?.rule, 'invalid-project-source-metadata');
  }
});
