import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { makeSpendingLogRouter } from './router.js';
import type { QuaestorSpendingLogExport } from './contract.js';

function requestFrom(
  app: ReturnType<typeof makeSpendingLogRouter>,
  address: string,
  url: string,
  init?: RequestInit,
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

function sampleExport(records = [sampleRecord()]): QuaestorSpendingLogExport {
  return {
    schema_version: 1,
    privacy_class: 'sensitive.financial_location',
    retention_scope: 'local_only',
    llm_relay_scope: 'diary_only',
    date_from: '2026-07-01',
    date_to: '2026-07-31',
    records,
    daily_summaries: [],
  };
}

function sampleRecord() {
  return {
    id: 'transaction:tx-1',
    privacy_class: 'sensitive.financial_location' as const,
    retention_scope: 'local_only' as const,
    llm_relay_scope: 'diary_only' as const,
    source_kind: 'transaction' as const,
    date: '2026-07-20',
    occurred_at: '2026-07-20T04:00:00.000Z',
    amount: 1_500,
    currency: 'JPY',
    place: {
      name: 'サンプルストア',
      google_place_id: null,
      google_maps_url: 'https://www.google.com/maps/search/?api=1&query=35.6%2C139.7',
      location: { latitude: 35.6, longitude: 139.7, accuracy_m: 10 },
    },
    payment: { kind: 'digital_wallet' as const, label: 'PayPay' },
    items: [{ name: 'コーヒー飲料', price: 1_500, quantity: 1, category: 'food' as const }],
    purchase_category: 'food' as const,
    expense: { planned: null, rate: null, rule_id: null },
    source_refs: { transaction_id: 'tx-1', receipt_ids: ['receipt-1'] },
    source_updated_at: '2026-07-20T04:01:00.000Z',
  };
}

test('spending-log sync stores sensitive local-only records and calculates daily totals', async () => {
  const db = openDb(':memory:');
  try {
    let requestedUrl = '';
    const fakeFetch: typeof fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify(sampleExport()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const app = makeSpendingLogRouter({
      db,
      quaestorBaseUrl: 'http://127.0.0.1:9999',
      fetchImpl: fakeFetch,
    });
    const sync = await requestFrom(app, '127.0.0.1', 'http://127.0.0.1/api/spending-logs/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_from: '2026-07-01', date_to: '2026-07-31' }),
    });
    assert.equal(sync.status, 200);
    assert.match(requestedUrl, /date_from=2026-07-01/);

    const listed = await requestFrom(
      app,
      '::ffff:127.0.0.1',
      'http://localhost/api/spending-logs?date_from=2026-07-20&date_to=2026-07-20',
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get('Cache-Control'), 'no-store');
    const body = await listed.json() as {
      count: number;
      records: Array<{ privacy_class: string; place: { location: { latitude: number } } }>;
      daily_summaries: Array<{ total_amount: number; places: Array<{ amount: number }> }>;
    };
    assert.equal(body.count, 1);
    assert.equal(body.records[0]?.privacy_class, 'sensitive.financial_location');
    assert.equal(body.records[0]?.place.location.latitude, 35.6);
    assert.equal(body.daily_summaries[0]?.total_amount, 1_500);
    assert.equal(body.daily_summaries[0]?.places[0]?.amount, 1_500);
  } finally {
    db.close();
  }
});

test('spending-log endpoints reject non-loopback access and remote Quaestor URLs', async () => {
  const db = openDb(':memory:');
  try {
    const app = makeSpendingLogRouter({
      db,
      quaestorBaseUrl: 'https://quaestor.example.com',
    });
    const remote = await requestFrom(
      app,
      '192.168.1.20',
      'http://memoria.lan/api/spending-logs',
    );
    assert.equal(remote.status, 403);

    const sync = await requestFrom(app, '127.0.0.1', 'http://127.0.0.1/api/spending-logs/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_from: '2026-07-01', date_to: '2026-07-31' }),
    });
    assert.equal(sync.status, 502);
    assert.match(await sync.text(), /loopback address/);
  } finally {
    db.close();
  }
});

test('re-sync replaces stale records within the requested range', async () => {
  const db = openDb(':memory:');
  try {
    let response = sampleExport();
    const fakeFetch: typeof fetch = async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const app = makeSpendingLogRouter({
      db,
      quaestorBaseUrl: 'http://localhost:9999',
      fetchImpl: fakeFetch,
    });
    const sync = () => requestFrom(app, '127.0.0.1', 'http://localhost/api/spending-logs/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_from: '2026-07-01', date_to: '2026-07-31' }),
    });
    assert.equal((await sync()).status, 200);
    response = sampleExport([]);
    const second = await sync();
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { removed: number };
    assert.equal(secondBody.removed, 1);

    const listed = await requestFrom(app, '127.0.0.1', 'http://localhost/api/spending-logs');
    const listBody = await listed.json() as { count: number };
    assert.equal(listBody.count, 0);
  } finally {
    db.close();
  }
});
