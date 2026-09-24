import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseKantoPage } from './parser.js';

function page(options: { broken?: boolean; conflict?: boolean } = {}): string {
  const row = (id: number, name = '路線' + id) => '<tr><td><a href="/diainfo/' + id + '/0">' + name
    + '</a></td><td>' + (id === 1 ? '運転見合わせ' : '平常運転') + '</td><td>運行案内</td></tr>';
  const groups = Array.from({ length: 10 }, (_, group) => '<div><h3>事業者' + group + '</h3></div><div><table>'
    + Array.from({ length: 10 }, (_, index) => row(group * 10 + index + 1)).join('')
    + (group === 0 && options.conflict ? row(1, '別路線') : '') + '</table></div>').join('');
  return '<div id="main"><div class="labelLarge"><h1>運行情報 関東</h1><span>9月24日 13時24分更新</span></div>'
    + '<div id="mdStatusTroubleLine"><table>' + row(1) + '</table></div>'
    + '<div id="mdAreaMajorLine">' + (options.broken ? groups.slice(0, groups.indexOf('</table>')) : groups) + '</div></div>';
}

test('reads normal and disrupted lines once, excluding the duplicated summary', () => {
  const data = parseKantoPage(page());
  assert.equal(data.lines.length, 100);
  assert.equal(data.lines.filter(line => line.disrupted).length, 1);
  assert.equal(data.lines[0].company, '事業者0');
  assert.equal(data.sourceUpdatedAt, '9月24日 13時24分更新');
  assert.equal(data.lines[0].url, 'https://transit.yahoo.co.jp/diainfo/1/0');
});

test('does not turn partial pages, login pages or conflicting rows into normal service', () => {
  for (const html of ['<h1>ログイン</h1>', page({ broken: true }), page({ conflict: true }),
    page().replace('9月24日 13時24分更新', ''), page().replaceAll('運転見合わせ', '')]) {
    assert.throws(() => parseKantoPage(html));
  }
});

test('retains the separate sections of a railway line', () => {
  const data = parseKantoPage(page().replaceAll('/diainfo/1/0', '/diainfo/43/43').replaceAll('/diainfo/2/0', '/diainfo/43/44'));
  assert.equal(data.lines.length, 100);
  assert.equal(data.lines[0].id, '/diainfo/43/43');
  assert.equal(data.lines[1].id, '/diainfo/43/44');
});
