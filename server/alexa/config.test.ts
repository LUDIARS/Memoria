import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadAlexaConfig,
  normalizeAlexaApiEndpoint,
  proactiveEventsUrl,
} from './config.js';

test('Alexa env未設定では連携を無効化する', () => {
  const config = loadAlexaConfig({});
  assert.equal(config.inboundEnabled, false);
  assert.equal(config.proactiveEnabled, false);
  assert.equal(config.proactiveStage, 'development');
});

test('Proactive Events資格情報はペアを要求する', () => {
  assert.throws(
    () => loadAlexaConfig({ MEMORIA_ALEXA_CLIENT_ID: 'client' }),
    /must be configured together/,
  );
});

test('Alexa API endpointをAmazonの固定allowlistへ制限する', () => {
  assert.equal(normalizeAlexaApiEndpoint('https://api.fe.amazon.com/'), 'https://api.fe.amazon.com');
  assert.equal(normalizeAlexaApiEndpoint('https://example.com'), null);
  assert.equal(
    proactiveEventsUrl('https://api.fe.amazon.com', 'development'),
    'https://api.fe.amazon.com/v1/proactiveEvents/stages/development',
  );
});

test('不正なProactive Events stageを拒否する', () => {
  assert.throws(
    () => loadAlexaConfig({ MEMORIA_ALEXA_PROACTIVE_STAGE: 'production' }),
    /must be development or live/,
  );
});
