import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { openDb, setAppSettings, insertAiArticle } from '../db.js';
import { makeAiHubRouter } from './ai-hub.js';

const HUB_URL = 'http://hub.test';

/** Multi モードで Hub にログイン済みの状態を作る。 */
function connectHub(db: ReturnType<typeof openDb>): void {
  setAppSettings(db, {
    multi_mode: 'multi',
    multi_mode_url: HUB_URL,
    multi_servers: JSON.stringify([
      { label: 'test hub', url: HUB_URL, jwt: 'session-token', userId: 'u1', userName: 'tester' },
    ]),
  });
}

function addForbiddenTerm(db: ReturnType<typeof openDb>, term: string): void {
  db.prepare(
    "INSERT INTO achievement_redaction_terms (term, origin, created_at) VALUES (?, 'manual', '2026-07-31T00:00:00Z')",
  ).run(term);
}

function makeApp(db: ReturnType<typeof openDb>): Hono {
  const app = new Hono();
  app.route('/', makeAiHubRouter({ db }));
  return app;
}

test('禁止語を含む記事は push せず 409 を返す', async () => {
  const db = openDb(':memory:');
  const originalFetch = globalThis.fetch;
  try {
    connectHub(db);
    addForbiddenTerm(db, 'Makai Nui');
    // 表記ゆれ (区切り違い) でも捕まることを、 実際の共有経路で確かめる。
    const id = insertAiArticle(db, { title: '週報', body_md: 'makai-nui の実装を進めた' });

    let called = 0;
    globalThis.fetch = async () => {
      called += 1;
      return new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await makeApp(db).request(`/api/ai/articles/${id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    assert.equal(res.status, 409);
    const payload = await res.json() as { error: string; blocked: { field: string; term: string }[] };
    assert.equal(payload.error, 'redaction_blocked');
    assert.equal(payload.blocked[0]?.term, 'Makai Nui');
    // 一番大事な性質: 弾いたときに Hub へ 1 度も出ていないこと。
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('禁止語が無ければ push し、 source_refs は既定で送らない', async () => {
  const db = openDb(':memory:');
  const originalFetch = globalThis.fetch;
  try {
    connectHub(db);
    const id = insertAiArticle(db, {
      title: 'Vulkan の descriptor indexing',
      body_md: '公開してよい一般的な記事',
      topic_key: 'LUDIARS/Secret:descriptor-indexing',
      tags: [
        { category: '言語', value: 'TypeScript' },
        { category: 'プロジェクト', value: 'LUDIARS/Secret' },
      ],
      source_refs: [{ kind: 'commit', ref: 'abc1234', repo: 'LUDIARS/Secret' }],
    });

    let sentBody: Record<string, unknown> | undefined;
    let sentPath = '';
    globalThis.fetch = async (input, init) => {
      sentPath = String(input);
      assert.equal(init?.redirect, 'error');
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // Hub の POST /api/data/:type は作成行をそのまま返す (包まない)。
      return new Response(JSON.stringify({ id: 42, origin_local_id: id }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const res = await makeApp(db).request(`/api/ai/articles/${id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    assert.equal(res.status, 200);
    assert.ok(sentPath.includes('/api/data/ai-articles'));
    // repo 名の露出を避けるため、 明示要求が無い限り source_refs は出さない。
    assert.equal(sentBody?.source_refs_json, null);
    // topic_key も `repo:theme` で repo 名を含むので既定では出さない。
    assert.equal(sentBody?.topic_key, null);
    // `プロジェクト` タグも source_refs 由来の repo 名なので既定では出さない。
    assert.deepEqual(sentBody?.tags_json, [{ category: '言語', value: 'TypeScript' }]);
    // 落としたことが監査列に残る。
    assert.equal(sentBody?.share_policy, 'redacted');
    // Hub 側の NOT NULL 制約を満たす証跡が必ず載る。
    assert.equal(typeof sentBody?.redaction_scanned_at, 'string');
    // Hub が返した行 id を呼び出し側に返す (取り違えると unshare の手掛かりを失う)。
    assert.deepEqual(await res.json(), { ok: true, remoteId: 42 });
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('includeSourceRefs は共有可能な repo でなければ 400', async () => {
  const db = openDb(':memory:');
  const originalFetch = globalThis.fetch;
  try {
    connectHub(db);
    const id = insertAiArticle(db, {
      title: 'x',
      body_md: 'y',
      source_refs: [{ kind: 'commit', ref: 'abc1234', repo: 'LUDIARS/Secret' }],
    });

    let called = 0;
    globalThis.fetch = async () => {
      called += 1;
      return new Response('{}', { status: 201 });
    };

    const res = await makeApp(db).request(`/api/ai/articles/${id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeSourceRefs: true }),
    });

    // achievement_sources が未作成 = full policy を確認できない → 出さない。
    assert.equal(res.status, 400);
    const payload = await res.json() as { error: string; repos: string[] };
    assert.equal(payload.error, 'source_refs_not_shareable');
    assert.deepEqual(payload.repos, ['LUDIARS/Secret']);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('full policy でも source_refs に対応しない project tag と topic_key は送らない', async () => {
  const db = openDb(':memory:');
  const originalFetch = globalThis.fetch;
  try {
    connectHub(db);
    db.exec('CREATE TABLE achievement_sources (repo_key TEXT PRIMARY KEY, share_policy TEXT NOT NULL)');
    db.prepare("INSERT INTO achievement_sources (repo_key, share_policy) VALUES ('LUDIARS/Public', 'full')").run();
    const id = insertAiArticle(db, {
      title: 'x',
      body_md: 'y',
      topic_key: 'LUDIARS/Secret:internal-theme',
      tags: [
        { category: '言語', value: 'TypeScript' },
        { category: 'プロジェクト', value: 'LUDIARS/Public' },
        { category: 'プロジェクト', value: 'LUDIARS/Secret' },
      ],
      source_refs: [{ kind: 'commit', ref: 'abc1234', repo: 'LUDIARS/Public' }],
    });

    let sentBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 42 }), { status: 201 });
    };

    const res = await makeApp(db).request(`/api/ai/articles/${id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeSourceRefs: true }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(sentBody?.tags_json, [
      { category: '言語', value: 'TypeScript' },
      { category: 'プロジェクト', value: 'LUDIARS/Public' },
    ]);
    assert.equal(sentBody?.topic_key, null);
    assert.deepEqual(sentBody?.source_refs_json, [{ kind: 'commit', ref: 'abc1234', repo: 'LUDIARS/Public' }]);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('Hub に届かなければ 502 (成功扱いにしない)', async () => {
  const db = openDb(':memory:');
  const originalFetch = globalThis.fetch;
  try {
    connectHub(db);
    const id = insertAiArticle(db, { title: 'x', body_md: 'y' });
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };

    const res = await makeApp(db).request(`/api/ai/articles/${id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    assert.equal(res.status, 502);
    assert.equal((await res.json() as { error: string }).error, 'hub_unreachable');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('unshare は 2 ページ目にある自分の行を見つけて消す', async () => {
  const db = openDb(':memory:');
  const originalFetch = globalThis.fetch;
  try {
    connectHub(db);
    const id = insertAiArticle(db, { title: 'x', body_md: 'y' });

    // 1 ページ目は満杯 (= まだ続きがある) で、 同じ origin_local_id の他人の行だけ入れる。
    // ここで止まって他人の行を消したら重大事故なので、 その分岐を固定する。
    const page0 = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1, origin_local_id: i === 0 ? id : 9000 + i, owner_user_id: i === 0 ? 'other' : 'u1',
    }));
    const page1 = [{ id: 777, origin_local_id: id, owner_user_id: 'u1' }];

    const calls: { path: string; method: string }[] = [];
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      calls.push({ path, method: init?.method ?? 'GET' });
      if (path.includes('offset=0')) {
        return new Response(JSON.stringify({ items: page0 }), { status: 200 });
      }
      if (path.includes('offset=200')) {
        return new Response(JSON.stringify({ items: page1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const res = await makeApp(db).request(`/api/ai/articles/${id}/unshare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const deleted = calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
    assert.deepEqual(deleted, [`${HUB_URL}/api/data/ai-articles/777`]);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('Hub に無い記事の unshare は 404 not_shared', async () => {
  const db = openDb(':memory:');
  const originalFetch = globalThis.fetch;
  try {
    connectHub(db);
    const id = insertAiArticle(db, { title: 'x', body_md: 'y' });
    let deletes = 0;
    globalThis.fetch = async (input, init) => {
      if ((init?.method ?? 'GET') === 'DELETE') deletes += 1;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };

    const res = await makeApp(db).request(`/api/ai/articles/${id}/unshare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    assert.equal(res.status, 404);
    assert.equal((await res.json() as { error: string }).error, 'not_shared');
    assert.equal(deletes, 0);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('Hub 未接続なら 503 (無言で成功にしない)', async () => {
  const db = openDb(':memory:');
  try {
    const id = insertAiArticle(db, { title: 'x', body_md: 'y' });
    const res = await makeApp(db).request(`/api/ai/articles/${id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json() as { error: string }).error, 'no_hub');
  } finally {
    db.close();
  }
});

test('share/check は push せず findings だけ返す', async () => {
  const db = openDb(':memory:');
  const originalFetch = globalThis.fetch;
  try {
    connectHub(db);
    addForbiddenTerm(db, 'Makai Nui');
    const blockedId = insertAiArticle(db, { title: 'ＭａｋａｉＮｕｉ 版', body_md: 'x' });
    insertAiArticle(db, { title: 'clean', body_md: 'y' });

    let called = 0;
    globalThis.fetch = async () => {
      called += 1;
      return new Response('{}', { status: 201 });
    };

    const res = await makeApp(db).request('/api/ai/articles/share/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    assert.equal(res.status, 200);
    const payload = await res.json() as { ok: boolean; blocked: { articleId: number }[] };
    assert.equal(payload.ok, false);
    // 全角表記でも拾う。
    assert.equal(payload.blocked[0]?.articleId, blockedId);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});
