import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { buildStayEvidence, groupStaysByDate } from './stay-match.js';
import type { SpendingLogRecord } from './contract.js';

function record(overrides: Partial<SpendingLogRecord> & { id: string }): SpendingLogRecord {
  return {
    privacy_class: 'sensitive.financial_location',
    retention_scope: 'local_only',
    llm_relay_scope: 'diary_only',
    source_kind: 'receipt',
    date: '2026-07-20',
    occurred_at: '2026-07-20T04:00:00.000Z',
    amount: 1_000,
    currency: 'JPY',
    place: {
      name: 'テスト店',
      google_place_id: null,
      google_maps_url: null,
      location: { latitude: 35.6000, longitude: 139.7000, accuracy_m: 10 },
    },
    payment: { kind: 'cash', label: null },
    items: [],
    purchase_category: 'food',
    expense: { planned: null, rate: null, rule_id: null },
    source_refs: { transaction_id: null, receipt_ids: [] },
    source_updated_at: '2026-07-20T04:01:00.000Z',
    ...overrides,
  } as SpendingLogRecord;
}

function dbWithPoints(points: Array<{
  at: string;
  lat: number;
  lon: number;
  placeName?: string | null;
  userId?: string;
}>) {
  const db = openDb(':memory:');
  const insert = db.prepare(
    `INSERT INTO gps_locations (user_id, recorded_at, lat, lon, accuracy_m, place_name)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const point of points) {
    insert.run(point.userId ?? 'me', point.at, point.lat, point.lon, 10, point.placeName ?? null);
  }
  return db;
}

test('近接する GPS 点があれば confirmed_by_gps', () => {
  const db = dbWithPoints([{ at: '2026-07-20T04:05:00.000Z', lat: 35.6001, lon: 139.7001 }]);
  const [evidence] = buildStayEvidence(db, [record({ id: 'r1' })]);
  assert.equal(evidence.status, 'confirmed_by_gps');
  assert.ok((evidence.distance_m ?? 0) < 300);
  assert.deepEqual(Object.keys(evidence.nearest_gps ?? {}).sort(), ['place_name', 'recorded_at']);
  db.close();
});

test('GPS 側に場所名が無ければ支出側の店名で補強する', () => {
  const db = dbWithPoints([{ at: '2026-07-20T04:05:00.000Z', lat: 35.6001, lon: 139.7001, placeName: null }]);
  const [evidence] = buildStayEvidence(db, [record({ id: 'r1' })]);
  assert.equal(evidence.enriched_place_name, 'テスト店');
  db.close();
});

test('遠く離れた GPS 点しか無ければ conflict', () => {
  const db = dbWithPoints([{ at: '2026-07-20T04:05:00.000Z', lat: 35.7000, lon: 139.8000 }]);
  const [evidence] = buildStayEvidence(db, [record({ id: 'r1' })]);
  assert.equal(evidence.status, 'conflict');
  db.close();
});

test('窓内に GPS 点が無ければ no_gps', () => {
  const db = dbWithPoints([{ at: '2026-07-20T10:00:00.000Z', lat: 35.6001, lon: 139.7001 }]);
  const [evidence] = buildStayEvidence(db, [record({ id: 'r1' })]);
  assert.equal(evidence.status, 'no_gps');
  assert.equal(evidence.nearest_gps, null);
  db.close();
});

test('支出側に座標が無ければ時刻一致のみ', () => {
  const db = dbWithPoints([{ at: '2026-07-20T04:05:00.000Z', lat: 35.6001, lon: 139.7001 }]);
  const noLocation = record({
    id: 'r1',
    place: { name: 'テスト店', google_place_id: null, google_maps_url: null, location: null },
  });
  const [evidence] = buildStayEvidence(db, [noLocation]);
  assert.equal(evidence.status, 'time_matched');
  assert.equal(evidence.distance_m, null);
  db.close();
});

test('時刻なしレシートは GPS と同じローカル日付で照合する', () => {
  const at = '2026-07-19T16:00:00.000Z';
  const db = dbWithPoints([{ at, lat: 35.6001, lon: 139.7001 }]);
  const localDate = (db.prepare(`SELECT date(?, 'localtime') AS day`).get(at) as { day: string }).day;
  const [evidence] = buildStayEvidence(db, [record({ id: 'r1', date: localDate, occurred_at: null })]);
  assert.equal(evidence.status, 'confirmed_by_gps');
  db.close();
});

test('別ユーザの GPS 点を本人の滞在証拠に使わない', () => {
  const db = dbWithPoints([
    { at: '2026-07-20T04:05:00.000Z', lat: 35.6001, lon: 139.7001, userId: 'other' },
    { at: '2026-07-20T04:06:00.000Z', lat: 35.7000, lon: 139.8000, userId: 'me' },
  ]);
  const [evidence] = buildStayEvidence(db, [record({ id: 'r1' })]);
  assert.equal(evidence.status, 'conflict');
  db.close();
});

test('日付でまとめて件数を数える', () => {
  const db = dbWithPoints([{ at: '2026-07-20T04:05:00.000Z', lat: 35.6001, lon: 139.7001 }]);
  const days = groupStaysByDate(buildStayEvidence(db, [record({ id: 'r1' }), record({ id: 'r2' })]));
  assert.equal(days.length, 1);
  assert.equal(days[0].confirmed_count, 2);
  db.close();
});
