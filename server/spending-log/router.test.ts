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
    let redirect: RequestInit['redirect'];
    const fakeFetch: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      redirect = init?.redirect;
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
    assert.equal(redirect, 'error');

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

test('Quaestor は本人同意が必要な relay scope を宣言できない', async () => {
  const db = openDb(':memory:');
  try {
    const exported = JSON.parse(JSON.stringify(sampleExport())) as {
      llm_relay_scope: string;
      records: Array<{ llm_relay_scope: string }>;
    };
    exported.llm_relay_scope = 'diary_and_spending_advice';
    exported.records[0].llm_relay_scope = 'diary_and_spending_advice';
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(exported), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const app = syncedApp(fetchImpl, db);
    const res = await requestFrom(app, '127.0.0.1', 'http://localhost/api/spending-logs/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_from: '2026-07-01', date_to: '2026-07-31' }),
    });
    assert.equal(res.status, 502);
    assert.match(await res.text(), /llm_relay_scope/);
  } finally {
    db.close();
  }
});

test('支出ログの外部リンクは http / https 以外を拒否する', async () => {
  const db = openDb(':memory:');
  try {
    const exported = JSON.parse(JSON.stringify(sampleExport())) as {
      records: Array<{ place: { google_maps_url: string | null } }>;
    };
    exported.records[0].place.google_maps_url = 'javascript:alert(1)';
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(exported), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const app = syncedApp(fetchImpl, db);
    const res = await requestFrom(app, '127.0.0.1', 'http://localhost/api/spending-logs/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_from: '2026-07-01', date_to: '2026-07-31' }),
    });
    assert.equal(res.status, 502);
    assert.match(await res.text(), /http or https/);
  } finally {
    db.close();
  }
});

test('spending-log endpoints accept Access-forwarded browsers and reject direct remote access', async () => {
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

    const access = await requestFrom(
      app,
      '127.0.0.1',
      'http://memoria.ai-run-do.com/api/spending-logs',
      {
        headers: {
          Origin: 'https://memoria.ai-run-do.com',
          'X-Forwarded-Proto': 'https',
        },
      },
    );
    assert.equal(access.status, 200);

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

function syncedApp(fetchImpl: typeof fetch, db: ReturnType<typeof openDb>) {
  return makeSpendingLogRouter({ db, quaestorBaseUrl: 'http://127.0.0.1:9999', fetchImpl });
}

function quaestorFetch(records = [sampleRecord()]): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes('/v1/integrations/memoria/spending-logs')) {
      return new Response(JSON.stringify(sampleExport(records)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // ローカル LLM (OpenAI 互換) の応答。
    return new Response(JSON.stringify({
      choices: [{ message: { content: '## 傾向\n- テスト助言' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

async function syncSample(app: ReturnType<typeof makeSpendingLogRouter>): Promise<void> {
  const res = await requestFrom(app, '127.0.0.1', 'http://localhost/api/spending-logs/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date_from: '2026-07-01', date_to: '2026-07-31' }),
  });
  assert.equal(res.status, 200);
}

test('source_kind でレシートとクレカを分けて取れる', async () => {
  const db = openDb(':memory:');
  try {
    const app = syncedApp(quaestorFetch(), db);
    await syncSample(app);

    const cards = await requestFrom(
      app,
      '127.0.0.1',
      'http://localhost/api/spending-logs?date_from=2026-07-20&date_to=2026-07-20&source_kind=transaction',
    );
    assert.equal(((await cards.json()) as { count: number }).count, 1);

    const receipts = await requestFrom(
      app,
      '127.0.0.1',
      'http://localhost/api/spending-logs?date_from=2026-07-20&date_to=2026-07-20&source_kind=receipt',
    );
    assert.equal(((await receipts.json()) as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

test('同意が無いうちは助言生成を 403 で断る', async () => {
  const db = openDb(':memory:');
  try {
    const app = syncedApp(quaestorFetch(), db);
    await syncSample(app);
    const res = await requestFrom(app, '127.0.0.1', 'http://localhost/api/spending-logs/advice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_from: '2026-07-01', date_to: '2026-07-31' }),
    });
    assert.equal(res.status, 403);
  } finally {
    db.close();
  }
});

test('同意すると既存行の relay scope が昇格し助言を生成できる', async () => {
  const db = openDb(':memory:');
  try {
    const app = syncedApp(quaestorFetch(), db);
    await syncSample(app);

    const consent = await requestFrom(app, '127.0.0.1', 'http://localhost/api/spending-logs/advice/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: true }),
    });
    assert.equal(consent.status, 200);
    const consentBody = await consent.json() as { relay_scope_updated: number };
    assert.equal(consentBody.relay_scope_updated, 1);

    const advice = await requestFrom(app, '127.0.0.1', 'http://localhost/api/spending-logs/advice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_from: '2026-07-01', date_to: '2026-07-31' }),
    });
    assert.equal(advice.status, 200);
    const adviceBody = await advice.json() as { report: { advice_markdown: string; record_count: number } };
    assert.match(adviceBody.report.advice_markdown, /テスト助言/);
    assert.equal(adviceBody.report.record_count, 1);
  } finally {
    db.close();
  }
});

test('同意を取り消すと昇格済みの行が diary_only に戻る', async () => {
  const db = openDb(':memory:');
  try {
    const app = syncedApp(quaestorFetch(), db);
    await syncSample(app);
    const put = (consent: boolean) => requestFrom(
      app,
      '127.0.0.1',
      'http://localhost/api/spending-logs/advice/settings',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent }),
      },
    );
    await put(true);
    const revoke = await put(false);
    assert.equal(((await revoke.json()) as { relay_scope_updated: number }).relay_scope_updated, 1);

    const advice = await requestFrom(app, '127.0.0.1', 'http://localhost/api/spending-logs/advice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_from: '2026-07-01', date_to: '2026-07-31' }),
    });
    assert.equal(advice.status, 403);
  } finally {
    db.close();
  }
});

test('助言の送信先が loopback でなければ生成しない', async () => {
  const db = openDb(':memory:');
  try {
    const app = syncedApp(quaestorFetch(), db);
    await syncSample(app);
    await requestFrom(app, '127.0.0.1', 'http://localhost/api/spending-logs/advice/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: true, base_url: 'https://api.openai.com/v1' }),
    });
    const advice = await requestFrom(app, '127.0.0.1', 'http://localhost/api/spending-logs/advice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_from: '2026-07-01', date_to: '2026-07-31' }),
    });
    assert.equal(advice.status, 502);
    assert.match(await advice.text(), /loopback/);
  } finally {
    db.close();
  }
});

test('滞在記録は GPS 点と突き合わせて返る', async () => {
  const db = openDb(':memory:');
  try {
    db.prepare(
      `INSERT INTO gps_locations (recorded_at, lat, lon, accuracy_m, place_name) VALUES (?, ?, ?, ?, ?)`,
    ).run('2026-07-20T04:05:00.000Z', 35.6001, 139.7001, 10, null);
    const app = syncedApp(quaestorFetch(), db);
    await syncSample(app);

    const stays = await requestFrom(
      app,
      '127.0.0.1',
      'http://localhost/api/spending-logs/stays?date_from=2026-07-20&date_to=2026-07-20',
    );
    assert.equal(stays.status, 200);
    const body = await stays.json() as {
      days: Array<{ confirmed_count: number; entries: Array<{ enriched_place_name: string | null }> }>;
    };
    assert.equal(body.days[0]?.confirmed_count, 1);
    assert.equal(body.days[0]?.entries[0]?.enriched_place_name, 'サンプルストア');
  } finally {
    db.close();
  }
});

test('傾向集計は LLM 同意なしでも返る', async () => {
  const db = openDb(':memory:');
  try {
    const app = syncedApp(quaestorFetch(), db);
    await syncSample(app);
    const res = await requestFrom(
      app,
      '127.0.0.1',
      'http://localhost/api/spending-logs/analytics?date_from=2026-07-01&date_to=2026-07-31',
    );
    assert.equal(res.status, 200);
    const body = await res.json() as { analytics: { total_amount: number; currency: string } };
    assert.equal(body.analytics.total_amount, 1_500);
    assert.equal(body.analytics.currency, 'JPY');
  } finally {
    db.close();
  }
});

test('存在しないカレンダー日付を拒否する', async () => {
  const db = openDb(':memory:');
  try {
    const app = syncedApp(quaestorFetch(), db);
    const res = await requestFrom(
      app,
      '127.0.0.1',
      'http://localhost/api/spending-logs/analytics?date_from=2026-02-30&date_to=2026-03-01',
    );
    assert.equal(res.status, 400);
  } finally {
    db.close();
  }
});

test('複数通貨では件数の多い通貨を既定にし、助言にも同じ通貨を使う', async () => {
  const db = openDb(':memory:');
  try {
    const records = [
      { ...sampleRecord(), id: 'usd-1', currency: 'USD' },
      { ...sampleRecord(), id: 'eur-1', currency: 'EUR' },
      { ...sampleRecord(), id: 'eur-2', currency: 'EUR' },
    ];
    const app = syncedApp(quaestorFetch(records), db);
    await syncSample(app);

    const analytics = await requestFrom(
      app,
      '127.0.0.1',
      'http://localhost/api/spending-logs/analytics?date_from=2026-07-01&date_to=2026-07-31',
    );
    const analyticsBody = await analytics.json() as {
      currencies: string[];
      analytics: { currency: string; record_count: number };
    };
    assert.deepEqual(analyticsBody.currencies, ['EUR', 'USD']);
    assert.equal(analyticsBody.analytics.currency, 'EUR');
    assert.equal(analyticsBody.analytics.record_count, 2);

    await requestFrom(app, '127.0.0.1', 'http://localhost/api/spending-logs/advice/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: true }),
    });
    const advice = await requestFrom(app, '127.0.0.1', 'http://localhost/api/spending-logs/advice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_from: '2026-07-01', date_to: '2026-07-31' }),
    });
    const adviceBody = await advice.json() as { report: { currency: string; record_count: number } };
    assert.equal(adviceBody.report.currency, 'EUR');
    assert.equal(adviceBody.report.record_count, 2);
  } finally {
    db.close();
  }
});
