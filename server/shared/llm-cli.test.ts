import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCodexLastMessage } from './llm-cli.js';

test('Codex output keeps the last assistant response across mixed log events', () => {
  const output = [
    'startup log',
    JSON.stringify({ message: { role: 'assistant', content: 'first' } }),
    JSON.stringify({ message: { role: 'user', content: 'not a response' } }),
    JSON.stringify({ payload: { message: { role: 'assistant', content: [{ text: 'final' }, { text: 'answer' }] } } }),
    JSON.stringify({ type: 'turn.completed' }),
    '',
  ].join('\n');
  assert.equal(extractCodexLastMessage(output), 'final\nanswer');
});

test('unrecognized output is preserved for caller error handling', () => {
  assert.equal(extractCodexLastMessage('plain response'), 'plain response');
  assert.equal(extractCodexLastMessage(''), '');
});
