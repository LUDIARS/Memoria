// LINE 連携 (Concordia 経由)。 Spec: spec/feature/line-relay.md
//
// - POST /api/integrations/line/webhook: Concordia だけが呼ぶ。 LINE の署名検証・reply API・秘密値は Concordia 側。
//   `Authorization: Bearer <中継トークン>` を保存済みハッシュと定数時間で照合し、 未発行 503 / 不一致 401 / 本文不正 400。
//   通ったら `{"replies":[...], "linked"?, "unlinked"?}` を返す。 本文・replyToken・トークンはログに出さない。
// - /api/line/relay/*: 設定画面用 (admin)。 中継トークンの発行 / 発行し直し / 消去と、「つなぐ」 用コードの発行。

import { Buffer } from 'node:buffer';
import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { requireScope } from '../lib/scoped-access.js';
import { memoriaLineRelayActions, type LineRelayActions } from '../line-relay/actions.js';
import { LineRelayBodyError, parseLineRelayEvents, type LineRelayEvent } from '../line-relay/events.js';
import { countLineLinkedTalks, issueLineLinkCode } from '../line-relay/links.js';
import { handleLineRelayBody } from '../line-relay/relay.js';
import {
  checkLineRelayToken,
  clearLineRelayToken,
  isLineRelayTokenIssued,
  issueLineRelayToken,
} from '../line-relay/token.js';

type Db = BetterSqlite3.Database;

const MAX_REQUEST_BYTES = 256 * 1024;

export interface LineRelayRouterDeps {
  db: Db;
  /** テスト用の差し替え口。 */
  actions?: LineRelayActions;
  now?: () => Date;
}

export interface LineRelayStatusView {
  token_set: boolean;
  linked_talks: number;
}

function statusView(db: Db): LineRelayStatusView {
  return { token_set: isLineRelayTokenIssued(db), linked_talks: countLineLinkedTalks(db) };
}

export function makeLineRelayRouter(deps: LineRelayRouterDeps): Hono {
  const r = new Hono();
  const actions = deps.actions ?? memoriaLineRelayActions(deps.db);

  r.post('/api/integrations/line/webhook', async (c: Context) => {
    const check = checkLineRelayToken(deps.db, c.req.header('authorization'));
    if (check === 'not_configured') return c.json({ error: 'integration_not_configured' }, 503);
    if (check === 'rejected') return c.json({ error: 'relay_token_rejected' }, 401);

    const rawBody = await c.req.text();
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_REQUEST_BYTES) return c.json({ error: 'bad_request' }, 400);
    let events: LineRelayEvent[];
    try {
      events = parseLineRelayEvents(JSON.parse(rawBody));
    } catch (error: unknown) {
      if (error instanceof SyntaxError || error instanceof LineRelayBodyError) return c.json({ error: 'bad_request' }, 400);
      throw error;
    }

    try {
      return c.json(await handleLineRelayBody({ db: deps.db, actions, now: deps.now }, events));
    } catch (error: unknown) {
      console.error(`[line-relay] request handling failed: ${error instanceof Error ? error.name : 'unknown error'}`);
      return c.json({ error: 'line_relay_failed' }, 500);
    }
  });

  r.use('/api/line/relay', requireScope('admin'));
  r.use('/api/line/relay/*', requireScope('admin'));

  r.get('/api/line/relay', (c: Context) => c.json(statusView(deps.db)));

  /** 発行 / 発行し直し。 平文はこの応答で 1 度だけ返す。 */
  r.post('/api/line/relay/token', (c: Context) => {
    const token = issueLineRelayToken(deps.db);
    return c.json({ ...statusView(deps.db), token });
  });

  r.delete('/api/line/relay/token', (c: Context) => {
    clearLineRelayToken(deps.db);
    return c.json(statusView(deps.db));
  });

  r.post('/api/line/relay/link-code', (c: Context) => c.json(issueLineLinkCode(deps.db, deps.now?.() ?? new Date())));

  return r;
}
