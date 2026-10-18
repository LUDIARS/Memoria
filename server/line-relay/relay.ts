// Concordia から届いた 1 本文 (= 1 トーク) を処理し、 `{"replies":[{replyToken, messages}], linked?, unlinked?}` を返す。
// LINE の reply API は Concordia が呼ぶ。 返事の無いイベントと replyToken の無いイベントは replies に載せない。

import type BetterSqlite3 from 'better-sqlite3';
import type { LineRelayActions } from './actions.js';
import { replyToLineEvent } from './conversation.js';
import type { LineRelayEvent } from './events.js';
import type { LineTextMessage } from './messages.js';
import { contract } from '../shared/contract-runtime.js'; /* augur-inject:import:2b6383a8 */
import augurContract_cdd7db98 from '../../augur/contracts/line-relay-replies.contract.js'; /* augur-inject:contract-predicate:c0ff3660 */

type Db = BetterSqlite3.Database;

/** LINE の reply API が 1 つの replyToken で送れるメッセージの上限。 */
export const MAX_REPLY_MESSAGES = 5;

export interface LineRelayReply {
  replyToken: string;
  messages: LineTextMessage[];
}

export interface LineRelayResponse {
  replies: LineRelayReply[];
  linked?: true;
  unlinked?: true;
}

export interface LineRelayDeps {
  db: Db;
  actions: LineRelayActions;
  now?: () => Date;
}

export async function handleLineRelayBody(deps: LineRelayDeps, events: LineRelayEvent[]): Promise<LineRelayResponse> {
  const replies: LineRelayReply[] = [];
  const used = new Set<string>();
  const response: LineRelayResponse = { replies };
  for (const event of events) {
    const reply = await replyToLineEvent({ db: deps.db, actions: deps.actions, now: deps.now?.() ?? new Date() }, event);
    if (reply.linked) response.linked = true;
    if (reply.unlinked) response.unlinked = true;
    const token = event.replyToken;
    if (token === undefined || reply.messages.length === 0 || used.has(token)) continue;
    used.add(token);
    replies.push({ replyToken: token, messages: reply.messages.slice(0, MAX_REPLY_MESSAGES) });
  }
  return response;
}
// @ts-expect-error augur-inject
handleLineRelayBody = contract(handleLineRelayBody, { ...augurContract_cdd7db98, contractId: 'C-18', mode: 'observe', sample: 1, where: 'server/line-relay/relay.ts:32', rule: 'contract-wrap', id: 'cdd7db98' }); /* augur-inject:contract-wrap:cdd7db98 */
