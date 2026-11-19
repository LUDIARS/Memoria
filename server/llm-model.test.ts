import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getLlmConfig, loadLlmConfigFromSettings, PROVIDER_MODELS, runLlm } from './llm.js';
import { resolveLlmModel } from './shared/llm-model.js';

test('Claude and Codex roles resolve from Concordia’s file and preserve context suffixes', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'memoria-model-roles-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const map = join(directory, 'roles.json');
  writeFileSync(map, JSON.stringify({ schemaVersion: 1, roles: {
    claude: { opus: 'claude-opus-fixture', fable: 'claude-fable-fixture' },
    codex: { astra: 'gpt-fixture-astra', sol: 'gpt-fixture-sol', luna: 'gpt-fixture-luna' },
  } }));
  const env = { LUDIARS_MODEL_ROLES_FILE: map };

  assert.equal(resolveLlmModel('claude', 'opus[1m]', env), 'claude-opus-fixture[1m]');
  assert.equal(resolveLlmModel('claude', 'fable', env), 'claude-fable-fixture');
  assert.equal(resolveLlmModel('codex', 'sol', env), 'gpt-fixture-sol');
  assert.equal(resolveLlmModel('codex', 'astra', env), 'gpt-fixture-astra');
  assert.equal(resolveLlmModel('codex', 'luna', env), 'gpt-fixture-luna');
  assert.equal(resolveLlmModel('claude', 'claude-opus-pinned[1m]', env), 'claude-opus-pinned[1m]');
  assert.equal(resolveLlmModel('codex', 'codex-mini-latest', env), 'codex-mini-latest');

  const missingMap = { LUDIARS_MODEL_ROLES_FILE: join(directory, 'missing.json') };
  assert.equal(resolveLlmModel('claude', 'opus[1m]', missingMap), 'opus[1m]');
  assert.throws(() => resolveLlmModel('codex', 'sol', missingMap), /model_role_unresolved:sol/);
});

test('provider presets expose roles and leave OpenAI API models to configuration', () => {
  assert.deepEqual(PROVIDER_MODELS.claude.map(({ id }) => id), ['sonnet', 'haiku', 'opus', 'opus[1m]', 'fable']);
  assert.deepEqual(PROVIDER_MODELS.codex.map(({ id }) => id), ['sol', 'astra', 'luna']);
  assert.deepEqual(PROVIDER_MODELS.openai, []);
});

test('OpenAI dispatch accepts a configured model ID and rejects an empty setting', async (t) => {
  t.after(() => loadLlmConfigFromSettings({}));
  const forward = process.env.MEMORIA_CONCORDIA_FORWARD;
  delete process.env.MEMORIA_CONCORDIA_FORWARD;
  t.after(() => {
    if (forward !== undefined) process.env.MEMORIA_CONCORDIA_FORWARD = forward;
  });
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = init?.body;
    assert(typeof body === 'string');
    assert.equal(JSON.parse(body).model, 'gpt-fixture-api');
    return Response.json({ choices: [{ message: { content: 'ok' } }] });
  });
  const settings = { 'llm.openai.api_key': 'test-key', 'llm.dig.provider': 'openai', 'llm.summarize.provider': 'openai' };
  loadLlmConfigFromSettings(settings);
  assert.equal(getLlmConfig().openai_model, '');
  await assert.rejects(runLlm({ task: 'dig', prompt: 'test' }), /OpenAI API model is not configured/);
  await assert.rejects(runLlm({ task: 'summarize', prompt: 'test' }), /OpenAI API model is not configured/);
  assert.equal(fetchMock.mock.callCount(), 0);

  loadLlmConfigFromSettings({ ...settings, 'llm.openai.model': 'gpt-fixture-api' });
  assert.equal(await runLlm({ task: 'dig', prompt: 'test' }), 'ok');
  assert.equal(fetchMock.mock.callCount(), 1);
});
