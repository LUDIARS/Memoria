import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNotionTransferReport,
  formatNotionTransferReport,
} from './notion-transfer-report.js';
import type { NotionTransferResult } from './notion-transfer-check.js';

const RESULTS: NotionTransferResult[] = [
  {
    id: 1,
    title: '公開可能な記事',
    transferable: true,
    disposition: 'transferable',
    findings: [],
  },
  {
    id: 2,
    title: 'person@example.com の連絡先',
    transferable: false,
    disposition: 'blocked',
    findings: [{
      check: 'sensitive-content',
      field: 'title',
      rule: 'email-address',
      index: 0,
    }],
  },
  {
    id: 3,
    title: '本文だけが転送不可の記事',
    transferable: false,
    disposition: 'blocked',
    findings: [{
      check: 'r18',
      field: 'body_md',
      rule: 'explicit-adult-content',
      index: 4,
    }],
  },
];

test('件数を集計し、検査に一致したタイトルだけを伏せる', () => {
  const report = buildNotionTransferReport(RESULTS, 4);

  assert.equal(report.total, 3);
  assert.equal(report.transferable, 1);
  assert.equal(report.generalizationRequired, 0);
  assert.equal(report.blocked, 2);
  assert.equal(report.checks.sensitiveContentFlagged, 1);
  assert.equal(report.checks.r18Blocked, 1);
  assert.doesNotMatch(report.blockedArticles[0]?.title ?? '', /example\.com/);
  assert.equal(report.blockedArticles[1]?.title, '本文だけが転送不可の記事');
});

test('人向け出力に全検査の集計を含め、機密タイトルを再出力しない', () => {
  const output = formatNotionTransferReport(buildNotionTransferReport(RESULTS, 4));

  assert.match(output, /Redaction blocked: 0/);
  assert.match(output, /Project confidentiality flagged: 0/);
  assert.match(output, /Sensitive content flagged: 1/);
  assert.match(output, /R18 blocked: 1/);
  assert.doesNotMatch(output, /person@example\.com/);
});

test('汎用化候補を遮断記事と分けて集計し、該当タイトルを伏せる', () => {
  const result: NotionTransferResult = {
    id: 4,
    title: String.raw`C:\Users\alice\work の構成`,
    transferable: false,
    disposition: 'generalization-required',
    findings: [{
      check: 'sensitive-content',
      field: 'title',
      rule: 'local-user-path',
      index: 0,
    }],
  };
  const report = buildNotionTransferReport([...RESULTS, result], 4);
  const output = formatNotionTransferReport(report);

  assert.equal(report.generalizationRequired, 1);
  assert.equal(report.blocked, 2);
  assert.equal(report.generalizationCandidates[0]?.title, '[redacted: title matched a safety rule]');
  assert.match(output, /Generalization candidates:\n- \[4\] \[redacted:/);
  assert.doesNotMatch(output, /Users\\alice/);
});
