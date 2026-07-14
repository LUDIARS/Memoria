import test from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_DOCS } from './config.js';

test('設定画面のAmazon EchoヘルプにAmazon側とMemoria側の手順を含める', () => {
  const help = SETUP_DOCS.alexa;
  assert.ok(help);
  assert.match(help.title, /Amazon Echo/);
  assert.match(help.body, /Alexa Developer Console/);
  assert.match(help.body, /AMAZON\.MessageAlert\.Activated/);
  assert.match(help.body, /MEMORIA_ALEXA_SKILL_ID/);
  assert.match(help.body, /MEMORIA_ALEXA_CLIENT_SECRET/);
});
