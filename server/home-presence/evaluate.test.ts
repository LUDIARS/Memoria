// 評価 (自宅・最新 GPS・状態) → 送信、 と旧 gps トリガー移行の結合テスト (in-memory DB)。

import '../tasks/test-backend.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, insertTask, openDb, setAppSettings } from '../db.js';
import { registerNotifySink, unregisterNotifySink, type NotifyDestination } from '../shared/notify-sink.js';
import { loadConfig, loadRules, saveConfig, saveRules } from './config.js';
import { evaluatePresence } from './evaluate.js';
import { dispatchEvent } from './engine.js';
import { resolveHome } from './home.js';
import { migrateGpsTriggers, splitGpsTriggers } from './migrate-gps-triggers.js';
import { loadState } from './state.js';

type Db = BetterSqlite3.Database;

// 試験用の架空座標 (緯度 0.001 度 ≒ 111m)
const HOME = { lat: 35.0, lon: 139.0 };

function addHome(db: Db, radius: number | null = 150): void {
  db.prepare(`INSERT INTO work_locations (name, latitude, longitude, is_home, radius_m) VALUES ('自宅', ?, ?, 1, ?)`)
    .run(HOME.lat, HOME.lon, radius);
}

function addFix(db: Db, dLat: number, at: number, accuracy: number | null = 10): void {
  db.prepare(`INSERT INTO gps_locations (user_id, recorded_at, lat, lon, accuracy_m) VALUES ('me', ?, ?, ?, ?)`)
    .run(new Date(at).toISOString(), HOME.lat + dLat, HOME.lon, accuracy);
}

function enable(db: Db): void {
  saveConfig(db, { ...loadConfig(db), enabled: true });
}

test('自宅は作業場所の自宅を優先し、 無ければ天気の固定座標', () => {
  const db = openDb(':memory:');
  try {
    assert.equal(resolveHome(db), null);
    setAppSettings(db, { 'weather.fixed_lat': '35.1', 'weather.fixed_lon': '139.1' });
    assert.equal(resolveHome(db)?.source, 'weather');
    assert.equal(resolveHome(db)?.radiusM, 200);
    addHome(db, null);
    const home = resolveHome(db);
    assert.equal(home?.source, 'work_location');
    assert.equal(home?.radiusM, 150);
  } finally {
    db.close();
  }
});

test('無効・自宅なし・GPS なし・古い GPS では判定しない', () => {
  const db = openDb(':memory:');
  const now = Date.parse('2026-10-13T10:00:00Z');
  try {
    assert.equal(evaluatePresence(db, now).skipped, 'disabled');
    enable(db);
    assert.equal(evaluatePresence(db, now).skipped, 'no_home');
    addHome(db);
    assert.equal(evaluatePresence(db, now).skipped, 'no_gps');
    addFix(db, 0, now - 20 * 60_000);
    assert.equal(evaluatePresence(db, now).skipped, 'stale_gps');
    assert.equal(loadState(db), null);
  } finally {
    db.close();
  }
});

test('精度の悪い点は使わない', () => {
  const db = openDb(':memory:');
  const now = Date.parse('2026-10-13T10:00:00Z');
  try {
    enable(db);
    addHome(db);
    addFix(db, 0, now - 60_000, 2000);
    assert.equal(evaluatePresence(db, now).skipped, 'no_gps');
  } finally {
    db.close();
  }
});

test('出発 → 近くに来た → 到着 の順に event が出る', () => {
  const db = openDb(':memory:');
  const t0 = Date.parse('2026-10-13T10:00:00Z');
  try {
    enable(db);
    addHome(db);
    addFix(db, 0, t0);
    assert.equal(evaluatePresence(db, t0).event, null); // 初回は基準だけ
    addFix(db, 0.03, t0 + 60_000); // 約 3.3km
    assert.equal(evaluatePresence(db, t0 + 60_000).event, 'depart');
    addFix(db, 0.006, t0 + 3_600_000); // 約 670m
    assert.equal(evaluatePresence(db, t0 + 3_600_000).event, 'approach');
    addFix(db, 0.0005, t0 + 3_700_000); // 約 55m
    assert.equal(evaluatePresence(db, t0 + 3_700_000).event, 'arrive');
    assert.equal(loadState(db)?.zone, 'home');
  } finally {
    db.close();
  }
});

test('event に合う有効な rule だけを送り先へ送る', async () => {
  const db = openDb(':memory:');
  const sent: { d: NotifyDestination; text: string }[] = [];
  registerNotifySink('line', async (d, text) => { sent.push({ d, text }); return true; });
  try {
    await insertTask(db, { title: '牛乳', category: '買い物' });
    await insertTask(db, { title: '資料', category: '開発' });
    saveRules(db, [
      { id: 'a', name: '買い物', enabled: true, event: 'depart', message: '', includeTasks: true,
        filter: { categories: ['買い物'], deadline: 'all' }, sendWhenEmpty: false, destinations: [{ kind: 'line' }] },
      { id: 'b', name: '無効', enabled: false, event: 'depart', message: '', includeTasks: false,
        filter: { categories: ['all'], deadline: 'all' }, sendWhenEmpty: false, destinations: [{ kind: 'line' }] },
      { id: 'c', name: '帰宅', enabled: true, event: 'arrive', message: 'おかえり', includeTasks: false,
        filter: { categories: ['all'], deadline: 'all' }, sendWhenEmpty: false, destinations: [{ kind: 'line' }] },
    ]);
    const res = await dispatchEvent(db, 'depart');
    assert.deepEqual(res.map((r) => r.ruleId), ['a']);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /家出発したよね/);
    assert.match(sent[0].text, /牛乳/);
    assert.doesNotMatch(sent[0].text, /資料/);
  } finally {
    unregisterNotifySink('line');
    db.close();
  }
});

test('送り先が未起動なら失敗として返し、 例外にしない', async () => {
  const db = openDb(':memory:');
  try {
    saveRules(db, [{ id: 'a', name: 'x', enabled: true, event: 'arrive', message: '', includeTasks: false,
      filter: { categories: ['all'], deadline: 'all' }, sendWhenEmpty: false, destinations: [{ kind: 'discord', channel: 'announce' }] }]);
    const [r] = await dispatchEvent(db, 'arrive');
    assert.equal(r.sent, false);
    assert.equal(r.results[0].ok, false);
  } finally {
    db.close();
  }
});

test('旧 gps トリガーを rule へ 1 回だけ移し、 他のトリガーは残す', () => {
  const db = openDb(':memory:');
  try {
    const old = [
      { id: 't1', name: '朝', enabled: true, trigger: { type: 'time', at: '08:00' }, filter: { categories: ['all'], deadline: 'all' }, channel: 'task' },
      { id: 'g1', name: '帰宅タスク', enabled: true, trigger: { type: 'gps', event: 'arrive', radius_m: 300 },
        filter: { categories: ['買い物'], deadline: 'all' }, channel: 'task' },
    ];
    setAppSettings(db, { 'features.discord.notify.triggers': JSON.stringify(old) });
    assert.equal(migrateGpsTriggers(db), 1);
    const rules = loadRules(db);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, 'g1');
    assert.equal(rules[0].event, 'arrive');
    assert.deepEqual(rules[0].destinations, [{ kind: 'discord', channel: 'task' }]);
    assert.equal(loadConfig(db).enabled, true);
    const rest = JSON.parse(getAppSettings(db)['features.discord.notify.triggers'] ?? '[]') as { id: string }[];
    assert.deepEqual(rest.map((t) => t.id), ['t1']);
    // 2 回目は何もしない
    assert.equal(migrateGpsTriggers(db), 0);
    assert.equal(loadRules(db).length, 1);
  } finally {
    db.close();
  }
});

test('分割は gps 以外をそのまま残す', () => {
  const { rules, rest } = splitGpsTriggers([{ id: 'x', trigger: { type: 'random' } }, null]);
  assert.equal(rules.length, 0);
  assert.equal(rest.length, 2);
});
