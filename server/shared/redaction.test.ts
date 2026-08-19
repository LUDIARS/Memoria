import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanForbiddenTerms } from './redaction.js';

const TERM = 'Makai Nui';

function scan(value: string) {
  return scanForbiddenTerms({ body: value }, [TERM]);
}

test('単純一致を検出する', () => {
  assert.equal(scan('Makai Nui を含む').length, 1);
});

test('大文字小文字違いを検出する', () => {
  assert.equal(scan('makai nui を含む').length, 1);
});

test('全角を検出する', () => {
  assert.equal(scan('Ｍａｋａｉ　Ｎｕｉ を含む').length, 1);
});

test('区切り違いを検出する', () => {
  assert.equal(scan('Makai-Nui').length, 1);
  assert.equal(scan('Makai_Nui').length, 1);
  assert.equal(scan('Makai Nui').length, 1);
});

test('改行で分断された語を検出する', () => {
  // 記事本文は Markdown なので、 語が行またぎで折り返される。 \s を畳むので当たる。
  assert.equal(scan('Makai\nNui').length, 1);
  assert.equal(scan('Makai\r\n\tNui').length, 1);
});

test('複数フィールドそれぞれから検出する', () => {
  const findings = scanForbiddenTerms({ title: 'Makai Nui 版', body: 'makai-nui の件' }, [TERM]);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((f) => f.field).sort(), ['body', 'title']);
});

test('null / undefined フィールドは無視する', () => {
  assert.deepEqual(scanForbiddenTerms({ a: null, b: undefined }, [TERM]), []);
});

test('該当なしは findings を返さない', () => {
  assert.deepEqual(scan('公開してよい一般的な記事'), []);
});
