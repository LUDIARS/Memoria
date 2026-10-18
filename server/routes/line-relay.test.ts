import '../tasks/test-backend.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { getDiary, openDb, upsertDiary } from '../db.js';
import { memoriaLineRelayActions } from '../line-relay/actions.js';
import { issueLineLinkCode, isLineTalkLinked } from '../line-relay/links.js';
import { issueLineRelayToken } from '../line-relay/token.js';
import { formatLocalDate } from '../shared/diary-append.js';
import { makeLineRelayRouter } from './line-relay.js';

type Db = BetterSqlite3.Database;

// 架空の値だけを使う。 実 LINE / Concordia は呼ばない。
const NOW = new Date('2026-07-10T10:00:00.000Z');
const GROUP = { type: 'group', groupId: 'Cfakegroup0000', userId: 'Ufakeuser0000' };
const TALK = 'group:Cfakegroup0000';

interface Reply { replyToken: string; messages: { type: string; text: string; quickReply?: { items: { action: { data: string } }[] } }[] }
interface RelayBody { replies: Reply[]; linked?: boolean; unlinked?: boolean }

function setup(listToday?: () => Promise<{ title: string }[]>, now: () => Date = () => NOW): { db: Db; app: Hono; token: string } {
  const db = openDb(':memory:');
  const actions = memoriaLineRelayActions(db);
  if (listToday) actions.listTodayTasks = listToday;
  const app = new Hono();
  app.route('/', makeLineRelayRouter({ db, actions, now }));
  return { db, app, token: issueLineRelayToken(db) };
}

const textEvent = (text: string, replyToken = 'fake-reply-1') => ({
  type: 'message', replyToken, source: GROUP, message: { type: 'text', id: 'm1', text },
});
const postbackEvent = (data: string, replyToken = 'fake-reply-2') => ({ type: 'postback', replyToken, source: GROUP, postback: { data } });

async function send(app: Hono, token: string | null, events: unknown[]): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-concordia-line-channel': 'fake-channel' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.request('/api/integrations/line/webhook', {
    method: 'POST', headers, body: JSON.stringify({ destination: 'Ufakebot0000', events }),
  });
}

async function relay(app: Hono, token: string, events: unknown[]): Promise<RelayBody> {
  const res = await send(app, token, events);
  assert.equal(res.status, 200);
  return await res.json() as RelayBody;
}

async function link(db: Db, app: Hono, token: string): Promise<void> {
  const { code } = issueLineLinkCode(db, NOW);
  const body = await relay(app, token, [textEvent(`つなぐ ${code}`)]);
  assert.equal(body.linked, true);
}

const firstText = (body: RelayBody): string => body.replies[0]?.messages[0]?.text ?? '';
const yesData = (body: RelayBody): string => body.replies[0]!.messages[0]!.quickReply!.items[0]!.action.data;
const noData = (body: RelayBody): string => body.replies[0]!.messages[0]!.quickReply!.items[1]!.action.data;

test('中継トークン: 未発行は 503、不一致・欠落は 401、本文不正は 400', async () => {
  const db = openDb(':memory:');
  try {
    const app = new Hono();
    app.route('/', makeLineRelayRouter({ db, actions: memoriaLineRelayActions(db) }));
    const unissued = await send(app, 'fake-token', [textEvent('タスク 牛乳を買う')]);
    assert.equal(unissued.status, 503);
    assert.deepEqual(await unissued.json(), { error: 'integration_not_configured' });

    const token = issueLineRelayToken(db);
    const wrong = await send(app, 'fake-wrong-token', []);
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), { error: 'relay_token_rejected' });
    assert.equal((await send(app, null, [])).status, 401);

    const bad = await app.request('/api/integrations/line/webhook', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"destination":"x"}',
    });
    assert.equal(bad.status, 400);
    const broken = await app.request('/api/integrations/line/webhook', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{',
    });
    assert.equal(broken.status, 400);

    const ok = await send(app, token, []);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { replies: [] });
  } finally {
    db.close();
  }
});

test('中継トークンは発行し直すと前の値が使えなくなる', async () => {
  const { db, app, token } = setup();
  try {
    const next = issueLineRelayToken(db);
    assert.notEqual(next, token);
    assert.equal((await send(app, token, [])).status, 401);
    assert.equal((await send(app, next, [])).status, 200);
  } finally {
    db.close();
  }
});

test('つなぐ: 有効なコードで linked を返し、全角の数字と空白も受ける', async () => {
  const { db, app, token } = setup();
  try {
    const { code } = issueLineLinkCode(db, NOW);
    const wide = code.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
    const body = await relay(app, token, [textEvent(`つなぐ　${wide}`)]);
    assert.equal(body.linked, true);
    assert.equal(body.replies[0]?.replyToken, 'fake-reply-1');
    assert.match(firstText(body), /つながりました/);
    assert.equal(isLineTalkLinked(db, TALK), true);
  } finally {
    db.close();
  }
});

test('つなぐ: 期限切れ・使用済みは案内だけ返して linked にしない、知らないコードは黙る', async () => {
  let now = NOW;
  const { db, app, token } = setup(undefined, () => now);
  try {
    const expired = issueLineLinkCode(db, NOW);
    now = new Date(NOW.getTime() + 11 * 60 * 1000);
    const late = await relay(app, token, [textEvent(`つなぐ ${expired.code}`)]);
    assert.equal(late.linked, undefined);
    assert.match(firstText(late), /有効期限/);
    assert.equal(isLineTalkLinked(db, TALK), false);

    now = NOW;
    const fresh = issueLineLinkCode(db, NOW);
    assert.equal((await relay(app, token, [textEvent(`つなぐ ${fresh.code}`)])).linked, true);
    const again = await relay(app, token, [textEvent(`つなぐ ${fresh.code}`)]);
    assert.equal(again.linked, undefined);
    assert.match(firstText(again), /もう使われて/);

    const otherCode = fresh.code === '000000' ? '000001' : '000000';
    assert.deepEqual(await relay(app, token, [textEvent(`つなぐ ${otherCode}`)]), { replies: [] });
  } finally {
    db.close();
  }
});

test('つながっていないトークには「つなぐ」の案内を返す', async () => {
  const { db, app, token } = setup();
  try {
    const body = await relay(app, token, [textEvent('タスク 牛乳を買う'), postbackEvent('mm:yes:fakefakefakefake0')]);
    assert.equal(body.replies.length, 2);
    for (const reply of body.replies) assert.match(reply.messages[0]!.text, /つなぐ/);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});

test('タスク: 確認ボタンを出し、「はい」で 1 件だけ足す', async () => {
  const { db, app, token } = setup();
  try {
    await link(db, app, token);
    const ask = await relay(app, token, [textEvent('  タスク 牛乳を買う')]);
    assert.match(firstText(ask), /「牛乳を買う」をタスクに足しますか/);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 0);

    const done = await relay(app, token, [postbackEvent(yesData(ask))]);
    assert.match(firstText(done), /足しました/);
    const rows = db.prepare('SELECT title, status FROM tasks').all() as { title: string; status: string }[];
    assert.deepEqual(rows, [{ title: '牛乳を買う', status: 'todo' }]);

    const twice = await relay(app, token, [postbackEvent(yesData(ask))]);
    assert.match(firstText(twice), /もう使えません/);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 1);
  } finally {
    db.close();
  }
});

test('タスク: 「やめる」なら足さない', async () => {
  const { db, app, token } = setup();
  try {
    await link(db, app, token);
    const ask = await relay(app, token, [textEvent('タスク 牛乳を買う')]);
    const cancelled = await relay(app, token, [postbackEvent(noData(ask))]);
    assert.match(firstText(cancelled), /やめました/);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});

test('きょうのタスク: 今日の未完了を最大 10 件、短く返す', async () => {
  const titles = Array.from({ length: 12 }, (_, i) => ({ title: `架空のタスク${i + 1}` }));
  const { db, app, token } = setup(async () => titles);
  try {
    await link(db, app, token);
    const text = firstText(await relay(app, token, [textEvent('きょうのタスク')]));
    assert.match(text, /今日の未完了タスク \(12 件\)/);
    assert.equal(text.split('\n').filter((line) => line.startsWith('・')).length, 10);
    assert.match(text, /架空のタスク10/);
    assert.doesNotMatch(text, /架空のタスク11/);
    assert.match(text, /ほか 2 件/);
  } finally {
    db.close();
  }
});

test('きょうのタスク: 期限が今日以前の未完了だけを既存のタスク正本から読む', async () => {
  const { db, app, token } = setup();
  try {
    await link(db, app, token);
    const insert = db.prepare('INSERT INTO tasks (title, details, status, kind, creator_type, due_at) VALUES (?, \'\', ?, \'task\', \'human\', ?)');
    insert.run('期限切れの架空タスク', 'todo', '2026-07-01T09:00');
    insert.run('終わった架空タスク', 'done', '2026-07-01T09:00');
    insert.run('来月の架空タスク', 'todo', '2026-08-20T09:00');
    const text = firstText(await relay(app, token, [textEvent('きょうのタスク')]));
    assert.match(text, /期限切れの架空タスク/);
    assert.doesNotMatch(text, /終わった架空タスク|来月の架空タスク/);
  } finally {
    db.close();
  }
});

test('にっき: 確認ボタンの「はい」で今日の日記メモに追記し、前の本文を残す', async () => {
  const { db, app, token } = setup();
  try {
    await link(db, app, token);
    const date = formatLocalDate(NOW);
    upsertDiary(db, { date, notes: '08:00 前からあるメモ', status: 'pending' });
    const ask = await relay(app, token, [textEvent('にっき 公園を散歩した')]);
    assert.match(firstText(ask), /今日の日記に足しますか/);
    assert.equal(getDiary(db, date)?.notes, '08:00 前からあるメモ');

    const done = await relay(app, token, [postbackEvent(yesData(ask))]);
    assert.match(firstText(done), /日記に足しました/);
    const notes = String(getDiary(db, date)?.notes ?? '');
    assert.ok(notes.startsWith('08:00 前からあるメモ\n'));
    assert.ok(notes.endsWith(' 公園を散歩した'));
  } finally {
    db.close();
  }
});

test('言葉なしの発言には使い方を返す', async () => {
  const { db, app, token } = setup();
  try {
    await link(db, app, token);
    const text = firstText(await relay(app, token, [textEvent('こんにちは')]));
    assert.match(text, /タスク ○○/);
    assert.match(text, /きょうのタスク/);
    assert.match(text, /にっき ○○/);
  } finally {
    db.close();
  }
});

test('leave で紐付けを消して unlinked を返す', async () => {
  const { db, app, token } = setup();
  try {
    await link(db, app, token);
    const body = await relay(app, token, [{ type: 'leave', source: { type: 'group', groupId: 'Cfakegroup0000' } }]);
    assert.deepEqual(body, { replies: [], unlinked: true });
    assert.equal(isLineTalkLinked(db, TALK), false);
    const after = await relay(app, token, [textEvent('きょうのタスク')]);
    assert.match(firstText(after), /つなぐ/);
  } finally {
    db.close();
  }
});

function requestFrom(app: Hono, address: string, url: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(app.request(url, init, {
    incoming: { socket: { remoteAddress: address, remotePort: 12345, remoteFamily: 'IPv4' } },
  }));
}

test('設定 API: 同一端末だけ通し、中継トークンの平文は発行時だけ返す', async () => {
  const db = openDb(':memory:');
  try {
    const app = new Hono();
    app.route('/', makeLineRelayRouter({ db, actions: memoriaLineRelayActions(db) }));
    const local = '127.0.0.1';
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: '{}' };
    assert.equal((await requestFrom(app, '192.168.1.25', 'http://localhost/api/line/relay')).status, 403);
    assert.equal((await requestFrom(app, '192.168.1.25', 'http://localhost/api/line/relay/token', init)).status, 403);

    const issued = await (await requestFrom(app, local, 'http://localhost/api/line/relay/token', init)).json() as { token: string; token_set: boolean };
    assert.equal(issued.token_set, true);
    assert.ok(issued.token.length >= 32);
    const view = await (await requestFrom(app, local, 'http://localhost/api/line/relay')).json() as Record<string, unknown>;
    assert.deepEqual(view, { token_set: true, linked_talks: 0 });
    const code = await (await requestFrom(app, local, 'http://localhost/api/line/relay/link-code', init)).json() as { code: string };
    assert.match(code.code, /^\d{6}$/);
    const cleared = await (await requestFrom(app, local, 'http://localhost/api/line/relay/token', { method: 'DELETE' })).json() as Record<string, unknown>;
    assert.deepEqual(cleared, { token_set: false, linked_talks: 0 });
  } finally {
    db.close();
  }
});
