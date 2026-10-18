// Concordia からの中継トークン。 平文は発行時に 1 度だけ返し、 app_settings には SHA-256 のハッシュだけを置く。
// 照合は定数時間。 トークン・ハッシュはログ・画面に出さない。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';
import { contract } from '../shared/contract-runtime.js'; /* augur-inject:import:5378e566 */
import augurContract_1d172b60 from '../../augur/contracts/line-relay-token.contract.js'; /* augur-inject:contract-predicate:2ed00a4b */

type Db = BetterSqlite3.Database;

const KEY_TOKEN_HASH = 'features.line_relay.token_hash';

export type LineRelayTokenCheck = 'ok' | 'not_configured' | 'rejected';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function storedHash(db: Db): string {
  return (getAppSettings(db)[KEY_TOKEN_HASH] ?? '').trim();
}

export function isLineRelayTokenIssued(db: Db): boolean {
  return storedHash(db).length > 0;
}

/** 発行 / 発行し直し。 前のトークンはこの時点で使えなくなる。 */
export function issueLineRelayToken(db: Db): string {
  const token = randomBytes(32).toString('base64url');
  setAppSettings(db, { [KEY_TOKEN_HASH]: hashToken(token) });
  return token;
}

export function clearLineRelayToken(db: Db): void {
  setAppSettings(db, { [KEY_TOKEN_HASH]: null });
}

/** `Authorization: Bearer <token>` を保存済みハッシュと照合する。 */
export function checkLineRelayToken(db: Db, authorization: string | undefined): LineRelayTokenCheck {
  const stored = storedHash(db);
  if (!stored) return 'not_configured';
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!match) return 'rejected';
  const expected = Buffer.from(stored, 'utf8');
  const got = Buffer.from(hashToken(match[1]!), 'utf8');
  return expected.length === got.length && timingSafeEqual(expected, got) ? 'ok' : 'rejected';
}
// @ts-expect-error augur-inject
checkLineRelayToken = contract(checkLineRelayToken, { ...augurContract_1d172b60, contractId: 'C-15', mode: 'observe', sample: 1, where: 'server/line-relay/token.ts:38', rule: 'contract-wrap', id: '1d172b60' }); /* augur-inject:contract-wrap:1d172b60 */
