import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSensitiveContent } from './sensitive-content.js';

test('秘密鍵、トークン、メールアドレス、ローカルパスを分類する', () => {
  const findings = scanSensitiveContent({
    key: '-----BEGIN PRIVATE KEY-----',
    token: `github_pat_${'a'.repeat(24)}`,
    contact: 'person@example.com',
    path: String.raw`C:\Users\alice\work`,
    workspace: String.raw`E:\Document\Ars\Memoria`,
  });

  assert.deepEqual(
    findings.map((finding) => finding.rule).sort(),
    ['access-token', 'email-address', 'local-user-path', 'local-workspace-path', 'private-key'],
  );
});

test('一致値を finding に含めない', () => {
  const finding = scanSensitiveContent({ body: 'person@example.com' })[0];

  assert.deepEqual(finding, { field: 'body', rule: 'email-address', index: 0 });
});

test('暗号化秘密鍵と macOS のユーザーパスも検出する', () => {
  assert.equal(scanSensitiveContent({ key: '-----BEGIN ENCRYPTED PRIVATE KEY-----' })[0]?.rule, 'private-key');
  assert.equal(scanSensitiveContent({ path: '/Users/alice/work' })[0]?.rule, 'local-user-path');
});
