// zone 判定のヒステリシスと event 生成の単体テスト。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyZone, haversineMeters } from './zone.js';
import { detectEvent, eventForTransition } from './detect.js';

const radii = { homeM: 150, nearM: 1000, hysteresisM: 50 };

test('haversine は 緯度 0.001 度でおよそ 111m', () => {
  const d = haversineMeters({ lat: 35, lon: 139 }, { lat: 35.001, lon: 139 });
  assert.ok(d > 105 && d < 117, String(d));
});

test('初回は距離だけで zone を決める', () => {
  assert.equal(classifyZone(100, null, radii), 'home');
  assert.equal(classifyZone(600, null, radii), 'near');
  assert.equal(classifyZone(3000, null, radii), 'away');
});

test('自宅からは 半径 + 余裕 を超えるまで出ない', () => {
  assert.equal(classifyZone(190, 'home', radii), 'home');
  assert.equal(classifyZone(201, 'home', radii), 'near');
  assert.equal(classifyZone(1040, 'home', radii), 'near');
  assert.equal(classifyZone(1100, 'home', radii), 'away');
});

test('近くからは 近く半径 + 余裕 を超えるまで外にならない', () => {
  assert.equal(classifyZone(1040, 'near', radii), 'near');
  assert.equal(classifyZone(1060, 'near', radii), 'away');
  assert.equal(classifyZone(140, 'near', radii), 'home');
});

test('外からは 近く半径 ちょうどで近くになる (余裕を足さない)', () => {
  assert.equal(classifyZone(1000, 'away', radii), 'near');
  assert.equal(classifyZone(1020, 'away', radii), 'away');
});

test('遷移ごとの event', () => {
  assert.equal(eventForTransition('away', 'near'), 'approach');
  assert.equal(eventForTransition('away', 'home'), 'arrive');
  assert.equal(eventForTransition('near', 'home'), 'arrive');
  assert.equal(eventForTransition('home', 'near'), 'depart');
  assert.equal(eventForTransition('home', 'away'), 'depart');
  assert.equal(eventForTransition('near', 'away'), null);
  assert.equal(eventForTransition('home', 'home'), null);
});

test('初回は基準を保存するだけで event を出さない', () => {
  const r = detectEvent(null, 'home', 1000, 600_000);
  assert.equal(r.event, null);
  assert.deepEqual(r.next, { zone: 'home', lastEventAt: {} });
});

test('同じ event は cooldown 内なら出さないが zone は進める', () => {
  const now = 10_000_000;
  const first = detectEvent({ zone: 'home', lastEventAt: {} }, 'near', now, 600_000);
  assert.equal(first.event, 'depart');
  assert.equal(first.next.lastEventAt.depart, now);
  const back = detectEvent(first.next, 'home', now + 60_000, 600_000);
  assert.equal(back.event, 'arrive');
  const again = detectEvent(back.next, 'near', now + 120_000, 600_000);
  assert.equal(again.event, null);
  assert.equal(again.next.zone, 'near');
  const later = detectEvent({ ...again.next, zone: 'home' }, 'near', now + 700_000, 600_000);
  assert.equal(later.event, 'depart');
});
