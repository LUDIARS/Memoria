import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setAppSettings } from '../db.js';
import { getShareTokenStatus } from '../personality-export/share-token.js';
import { makePersonalityExportRouter } from './personality-export.js';

function requestFrom(
  app: ReturnType<typeof makePersonalityExportRouter>,
  address: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  return Promise.resolve(app.request(url, init, {
    incoming: {
      socket: {
        remoteAddress: address,
        remotePort: 12345,
        remoteFamily: address.includes(':') ? 'IPv6' : 'IPv4',
      },
    },
  }));
}

test('personality export management accepts Access forwarding but rejects direct remote access', async () => {
  const db = openDb(':memory:');
  try {
    const app = makePersonalityExportRouter({ db });
    const jsonHeaders = { 'Content-Type': 'application/json' };

    const remotePatch = await requestFrom(app, '192.168.1.25', 'http://memoria.lan/api/personality-export/settings', {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(remotePatch.status, 403);

    const crossSitePatch = await requestFrom(app, '127.0.0.1', 'http://localhost/api/personality-export/settings', {
      method: 'PATCH',
      headers: { ...jsonHeaders, Origin: 'https://attacker.example' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(crossSitePatch.status, 403);

    const accessHeaders = {
      Origin: 'https://memoria.ai-run-do.com',
      'X-Forwarded-Proto': 'https',
    };
    const accessPatch = await requestFrom(app, '127.0.0.1', 'http://memoria.ai-run-do.com/api/personality-export/settings', {
      method: 'PATCH',
      headers: { ...jsonHeaders, ...accessHeaders },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(accessPatch.status, 200);

    const accessIssue = await requestFrom(app, '127.0.0.1', 'http://memoria.ai-run-do.com/api/personality-export/token', {
      method: 'POST',
      headers: accessHeaders,
    });
    assert.equal(accessIssue.status, 200);
    assert.equal(getShareTokenStatus(db).hasToken, true);

    const remoteRevoke = await requestFrom(app, '192.168.1.25', 'http://memoria.lan/api/personality-export/token', {
      method: 'DELETE',
    });
    assert.equal(remoteRevoke.status, 403);
    assert.equal(getShareTokenStatus(db).hasToken, true);

    const accessRevoke = await requestFrom(app, '127.0.0.1', 'http://memoria.ai-run-do.com/api/personality-export/token', {
      method: 'DELETE',
      headers: accessHeaders,
    });
    assert.equal(accessRevoke.status, 200);
    assert.equal(getShareTokenStatus(db).hasToken, false);
  } finally {
    db.close();
  }
});

test('personality export settings rejects malformed or invalid JSON with 400', async () => {
  const db = openDb(':memory:');
  try {
    setAppSettings(db, { 'features.external_share.voluptas_personality.enabled': '0' });
    const app = makePersonalityExportRouter({ db });
    const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost' };

    const malformed = await requestFrom(app, '127.0.0.1', 'http://localhost/api/personality-export/settings', {
      method: 'PATCH',
      headers,
      body: '{',
    });
    assert.equal(malformed.status, 400);

    const wrongType = await requestFrom(app, '127.0.0.1', 'http://localhost/api/personality-export/settings', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: 'yes' }),
    });
    assert.equal(wrongType.status, 400);

    const status = await requestFrom(app, '127.0.0.1', 'http://localhost/api/personality-export/status', {
      headers,
    });
    assert.equal((await status.json() as { enabled: boolean }).enabled, false);
  } finally {
    db.close();
  }
});
