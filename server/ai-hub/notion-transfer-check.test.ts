import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNotionTransfer } from './notion-transfer-check.js';
import { collectProjectNamesFromSourceRefs } from './project-confidentiality.js';

test('全検査を title/body_md に適用し、一致があれば転送不可にする', () => {
  const result = checkNotionTransfer({
    id: 7,
    title: 'InternalProject の記録',
    body_md: '連絡先は person@example.com。成人向けの内容を含む。',
  }, ['InternalProject']);

  assert.equal(result.transferable, false);
  assert.equal(result.disposition, 'blocked');
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
  assert.equal(result.disposition, 'transferable');
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
      repo: 'https://example.invalid/example/PrivateProject.git',
    }]),
  }, []);
  const mentionResult = checkNotionTransfer({
    id: 10,
    title: '設計メモ',
    body_md: 'PX 案件の作業記録。',
  }, [], ['PX']);

  assert.equal(sourceResult.transferable, false);
  assert.equal(sourceResult.disposition, 'generalization-required');
  assert.equal(sourceResult.findings[0]?.rule, 'restricted-project-source');
  assert.equal(mentionResult.transferable, false);
  assert.equal(mentionResult.disposition, 'generalization-required');
  assert.equal(mentionResult.findings[0]?.rule, 'restricted-project-mention');
});

test('source_refs から案件名を導出し、別記事の本文言及も汎用化候補にする', () => {
  const projectNames = collectProjectNamesFromSourceRefs([{
    source_refs: JSON.stringify([{
      kind: 'git_commit',
      ref: 'abc123',
      repo: 'https://example.invalid/example/PrivateProject.git',
    }]),
  }]);
  const result = checkNotionTransfer({
    id: 14,
    title: '設計メモ',
    body_md: 'PrivateProject で採用した設計。',
  }, [], projectNames);

  assert.deepEqual(projectNames, ['PrivateProject']);
  assert.equal(result.disposition, 'generalization-required');
  assert.equal(result.findings[0]?.rule, 'restricted-project-mention');
});

test('汎用化可能なローカル情報に遮断所見が混在すれば fail-closed にする', () => {
  const generalizable = checkNotionTransfer({
    id: 15,
    title: 'ローカル構成',
    body_md: String.raw`設定は C:\Users\alice\work に置く。`,
  }, []);
  const mixed = checkNotionTransfer({
    id: 16,
    title: 'ローカル構成',
    body_md: String.raw`連絡先 person@example.com の設定は C:\Users\alice\work に置く。`,
  }, []);

  assert.equal(generalizable.disposition, 'generalization-required');
  assert.equal(mixed.disposition, 'blocked');
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
    assert.equal(result.disposition, 'blocked');
    assert.equal(result.findings[0]?.rule, 'invalid-project-source-metadata');
  }
});
