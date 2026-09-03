// LLM 書誌補完。 幻の ISBN を掴まないことと、 空返答を捨てることを見る。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBibPrompt, inferBibliography, parseBibOutput } from './llm-bib.js';
import type { BookCandidate } from './types.js';

const ANSWER = '```json\n{"title":"トリリオンゲーム","authors":["稲垣理一郎","池上遼一"],'
  + '"isbn13":"978-4-09-860731-4","publisher":"小学館","publishedOn":"2021年3月"}\n```';

function openBdHit(isbn: string): BookCandidate {
  return {
    isbn13: isbn, title: 'トリリオンゲーム 1', authors: ['稲垣 理一郎'], publisher: '小学館',
    series: 'ビッグコミックス', publishedOn: '2021-03-30', coverUrl: 'https://cover.example/1.jpg',
    url: null, source: 'openbd', rating: null, ratingCount: null, salesRank: null,
  };
}

test('プロンプトに入力タイトルと著者が入り、自信が無ければ null と指示する', () => {
  const prompt = buildBibPrompt('トリリオンゲーム', '稲垣理一郎');
  assert.match(prompt, /トリリオンゲーム/);
  assert.match(prompt, /稲垣理一郎/);
  assert.match(prompt, /自信が無ければ isbn13 は null/);
});

test('コードフェンス付きの出力を読み、ISBN と日付を正規化する', () => {
  const record = parseBibOutput(ANSWER, 'トリリオンゲーム');
  assert.equal(record?.isbn13, '9784098607314');
  assert.deepEqual(record?.authors, ['稲垣理一郎', '池上遼一']);
  assert.equal(record?.publishedOn, '2021-03');
});

test('中身の無い返答は null (タイトルだけの行を作らない)', () => {
  assert.equal(parseBibOutput('null', '本'), null);
  assert.equal(parseBibOutput('{"title":"本","authors":[],"isbn13":null,"publisher":null}', '本'), null);
  assert.equal(parseBibOutput('{"title":"本","authors":[],"publisher":"推定出版社"}', '本'), null);
  assert.equal(parseBibOutput('{"title":"本","authors":[],"isbn13":"invalid"}', '本'), null);
  assert.equal(parseBibOutput('わかりません', '本'), null);
});

test('authors の文字列以外は著者名として採用しない', () => {
  const record = parseBibOutput('{"title":"本","authors":[{"name":"秘密"},42,"著者"]}', '本');
  assert.deepEqual(record?.authors, ['著者']);
});

test('LLM の ISBN が openBD に実在すれば openBD の書誌を採る', async () => {
  const result = await inferBibliography('トリリオンゲーム', undefined, {
    runLlm: async () => ANSWER,
    lookupOpenBd: async (isbns) => new Map([[isbns[0], openBdHit(isbns[0])]]),
  });
  assert.equal(result?.isbn13, '9784098607314');
  assert.equal(result?.coverUrl, 'https://cover.example/1.jpg');
  assert.equal(result?.source, 'llm_inferred');
});

test('openBD に無い ISBN は捨て、裏の取れない出版社・発売日も採らない', async () => {
  const result = await inferBibliography('トリリオンゲーム', undefined, {
    runLlm: async () => ANSWER,
    lookupOpenBd: async () => new Map(),
  });
  assert.equal(result?.isbn13, null);
  // 著者はウォッチ対象の導出に要るので残す。
  assert.deepEqual(result?.authors, ['稲垣理一郎', '池上遼一']);
  // LLM は版元をよく間違える (実測で集英社と答えた) ので、裏が取れなければ捨てる。
  assert.equal(result?.publisher, null);
  assert.equal(result?.publishedOn, null);
});

test('openBD が落ちても著者だけは返す', async () => {
  const result = await inferBibliography('トリリオンゲーム', undefined, {
    runLlm: async () => ANSWER,
    lookupOpenBd: async () => { throw new Error('offline'); },
  });
  assert.equal(result?.isbn13, null);
  assert.equal(result?.publisher, null);
  assert.deepEqual(result?.authors, ['稲垣理一郎', '池上遼一']);
});
