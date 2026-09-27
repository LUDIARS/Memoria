import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { makePluginPackageRouter } from './package-router.js';
import { pluginCatalogSource } from './catalog-config.js';

test('catalog configuration is optional and secrets stay in request headers', () => {
  assert.equal(pluginCatalogSource({}), undefined);
  assert.throws(() => pluginCatalogSource({ MEMORIA_PLUGIN_CATALOG_TOKEN: 'secret' }), /requires/);
  for (const url of ['http://example.com/catalog.json', 'https://user:secret@example.com/catalog.json', 'https://example.com/?token=secret']) {
    assert.throws(() => pluginCatalogSource({ MEMORIA_PLUGIN_CATALOG_URL: url }));
  }
  const configured = pluginCatalogSource({ MEMORIA_PLUGIN_CATALOG_URL: 'https://example.com/catalog.json', MEMORIA_PLUGIN_CATALOG_TOKEN: 'secret' });
  assert.equal(configured?.url, 'https://example.com/catalog.json');
  assert.deepEqual(configured?.headers, { Authorization: 'Bearer secret' });
});

test('local installed list does not contact the catalog; mutations require origin and explicit trust', async () => {
  let catalogCalls = 0;
  let installs = 0;
  const packages = {
    async catalog() { catalogCalls++; return []; }, async install() { installs++; },
    async useVersion() {}, async uninstall() {},
  };
  const app = new Hono();
  app.route('/', makePluginPackageRouter({ packages, store: { async active() { return []; } }, configured: false }));
  const local = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
  const base = 'http://127.0.0.1:5180';
  assert.equal((await app.request(`${base}/api/plugin-packages/installed`, {}, local)).status, 200);
  assert.equal(catalogCalls, 0);
  assert.equal((await app.request(`${base}/api/plugin-packages/catalog`, {}, local)).status, 503);
  assert.equal(catalogCalls, 0);
  const body = JSON.stringify({ id: 'example', version: '1.0.0', sha256: 'a'.repeat(64), trusted: true });
  const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body };
  assert.equal((await app.request(`${base}/api/plugin-packages/install`, request, local)).status, 403);
  assert.equal((await app.request(`${base}/api/plugin-packages/install`, { ...request, headers: { ...request.headers, origin: 'https://evil.example' } }, local)).status, 403);
  assert.equal((await app.request(`${base}/api/plugin-packages/install`, { ...request, headers: { ...request.headers, origin: base } },
    { incoming: { socket: { remoteAddress: '192.0.2.1' } } })).status, 403);
  const accepted = { ...request, headers: { ...request.headers, origin: base, 'sec-fetch-site': 'same-origin' } };
  assert.equal((await app.request(`${base}/api/plugin-packages/install`, { ...accepted, body: JSON.stringify({ id: 'example' }) }, local)).status, 400);
  assert.equal(installs, 0);
  assert.equal((await app.request(`${base}/api/plugin-packages/install`, accepted, local)).status, 200);
  assert.equal(installs, 1);
});

test('package source failures do not expose transport credentials', async () => {
  const app = new Hono();
  app.route('/', makePluginPackageRouter({ configured: true, store: { async active() { return []; } }, packages: {
    async catalog() { throw new Error('Authorization: secret'); }, async install() {}, async useVersion() {}, async uninstall() {},
  } }));
  const response = await app.request('http://127.0.0.1:5180/api/plugin-packages/catalog', {}, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes('secret'), false);
});
