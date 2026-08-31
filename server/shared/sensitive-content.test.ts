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

test('環境設定、任意ユーザー以外の絶対パス、loopback endpoint、個人環境文脈を検出する', () => {
  const findings = scanSensitiveContent({
    environment: 'process.env.MEMORIA_TOKEN',
    path: '/etc/memoria/config.json',
    endpoint: 'http://[::1]:4321/api',
    context: '手元のPCでのみ再現する。',
  });

  assert.deepEqual(
    findings.map((finding) => finding.rule).sort(),
    [
      'absolute-local-path',
      'environment-configuration',
      'local-runtime-endpoint',
      'personal-environment-context',
    ],
  );
});

test('IPv4 loopback のアドレス範囲全体を検出する', () => {
  assert.equal(
    scanSensitiveContent({ endpoint: 'http://127.12.34.56:80/' })[0]?.rule,
    'local-runtime-endpoint',
  );
});

test('通常の home と公開 URL のパスをローカル環境として誤検出しない', () => {
  assert.deepEqual(scanSensitiveContent({
    body: 'Return to the home page at https://example.com/etc/reference.',
  }), []);
});
