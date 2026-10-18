// Contract for checkLineRelayToken (C-15): no stored hash means not_configured; only a matching bearer token is ok.

import { createHash } from 'node:crypto';

interface Db { prepare(sql: string): { get(...params: unknown[]): unknown } }

export default {
  post: (result: string, db: Db, authorization: string | undefined): true | string => {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'features.line_relay.token_hash'").get() as { value: string } | undefined;
    const stored = (row?.value ?? '').trim();
    if (!stored) return result === 'not_configured' || 'an unissued relay token must report not_configured';
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    const expected = match && createHash('sha256').update(match[1]!).digest('hex') === stored ? 'ok' : 'rejected';
    return result === expected || `relay token check must be ${expected}`;
  },
};
