// 書誌正規化のテスト。 ソースごとの表記ゆれを吸収できているかを見る。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanAuthors, dateFloor, guessSeries, normalizeDate, normalizeIsbn13, titleKey } from './bib.js';

test('titleKey はレーベル注記・記号・全角半角を畳むが巻数は残す', () => {
  assert.equal(titleKey('沈黙の艦隊 (講談社文庫)'), titleKey('沈黙の艦隊'));
  assert.equal(titleKey('ＴＨＥ　ＢＯＯＫ'), titleKey('the book'));
  assert.notEqual(titleKey('数学ガール（フェルマーの最終定理）'), titleKey('数学ガール（ガロア理論）'));
  assert.notEqual(titleKey('カード'), titleKey('カド'));
  assert.equal(titleKey('よくわかる指標 1'), 'よくわかる指標1');
  assert.notEqual(titleKey('よくわかる指標 1'), titleKey('よくわかる指標 2'));
});

test('normalizeIsbn13 は 10 桁を 13 桁に変換し、 ハイフンを無視する', () => {
  assert.equal(normalizeIsbn13('978-4-06-519465-6'), '9784065194656');
  assert.equal(normalizeIsbn13('4062194651'), '9784062194655');
  assert.equal(normalizeIsbn13('12345'), null);
  assert.equal(normalizeIsbn13(null), null);
});

test('normalizeDate は和暦表記・詰め表記・部分日付を扱う', () => {
  assert.equal(normalizeDate('2026年9月3日'), '2026-09-03');
  assert.equal(normalizeDate('20260903'), '2026-09-03');
  assert.equal(normalizeDate('2026/9/3'), '2026-09-03');
  assert.equal(normalizeDate('2026-09'), '2026-09');
  assert.equal(normalizeDate('2026'), '2026');
  assert.equal(normalizeDate('2026-02-30'), null);
  assert.equal(normalizeDate('2026-13'), null);
  assert.equal(normalizeDate('近日発売'), null);
});

test('dateFloor は月日が欠けた日付を月初・年初に寄せる', () => {
  assert.equal(dateFloor('2026-09')?.getMonth(), 8);
  assert.equal(dateFloor('2026-09')?.getDate(), 1);
  assert.equal(dateFloor(null), null);
});

test('cleanAuthors は役割表記を落として重複を除く', () => {
  assert.deepEqual(cleanAuthors(['山田 太郎／著', '山田 太郎', '訳者 花子／訳']), ['山田 太郎', '訳者 花子']);
  assert.deepEqual(cleanAuthors([null, '', undefined]), []);
});

test('guessSeries は巻数付きタイトルからシリーズ名を取る', () => {
  assert.equal(guessSeries('よくわかる指標 3'), 'よくわかる指標');
  assert.equal(guessSeries('よくわかる指標 第3巻'), 'よくわかる指標');
  assert.equal(guessSeries('単発の本'), null);
});
