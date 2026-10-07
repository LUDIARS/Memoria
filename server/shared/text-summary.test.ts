import test from 'node:test';
import assert from 'node:assert/strict';
import { textSummaryArgs, textSummaryEnvironment, runTextSummary, withSummaryBudget } from './text-summary.js';

test('要約の tools/MCP/hooks を停止し、親の権限・秘密・作業ディレクトリを引き継がない', () => {
  const args = textSummaryArgs('fake-model');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.ok(args.includes('{"disableAllHooks":true}'));
  const env = textSummaryEnvironment({ MEMORIA_SUMMARY_CLAUDE_TOKEN: 'fake-summary', HOME: '/privileged',
    MEMORIA_ADMIN_TOKEN: 'fake-admin', CONCORDIA_SESSION_ID: 'fake-session', NODE_OPTIONS: '--require evil',
    ANTHROPIC_API_KEY: 'fake-parent', PATH: '/runtime' }, '/isolated');
  assert.equal(env.HOME, '/isolated');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/isolated');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'fake-summary');
  assert.equal(env.MEMORIA_ADMIN_TOKEN, undefined);
  assert.equal(env.CONCORDIA_SESSION_ID, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.throws(() => textSummaryEnvironment({}, '/isolated'), /required/);
});

test('未対応 CLI は起動せず失敗し、大きすぎる要約入力を拒否する', async () => {
  await assert.rejects(runTextSummary({ provider: 'codex', model: 'fake', bin: 'never-run', baseUrl: '',
    prompt: 'untrusted', timeoutMs: 1 }), /unsupported/);
  await assert.rejects(withSummaryBudget('x'.repeat(40_001), async () => 'never'), /input exceeds/);
});
