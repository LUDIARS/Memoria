import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { isDirectLoopbackRequest } from './local-request.js';
import { contract } from '../shared/contract-runtime.js'; /* augur-inject:import:f38a07ac */
import augurContract_2bfd486e from '../../augur/contracts/security-access.contract.js'; /* augur-inject:contract-predicate:9919fd7a */

export type AccessScope = 'admin' | 'bookmark';

export function hasScopedAccess(c: Context, scope: AccessScope): boolean {
  const origin = c.req.header('origin');
  if (origin === 'null') return false;
  if (origin && !origin.startsWith('chrome-extension://') && !origin.startsWith('moz-extension://')) {
    try {
      // Explicit tokens may be used through a TLS terminating proxy; never trust forwarded Host.
      const url = new URL(c.req.url);
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== url.host) return false;
    } catch { return false; }
  }
  if (isDirectLoopbackRequest(c)) return true;
  const expected = process.env[scope === 'admin' ? 'MEMORIA_ADMIN_TOKEN' : 'MEMORIA_BOOKMARK_TOKEN'];
  const other = process.env[scope === 'admin' ? 'MEMORIA_BOOKMARK_TOKEN' : 'MEMORIA_ADMIN_TOKEN'];
  const got = c.req.header(scope === 'admin' ? 'x-memoria-admin-token' : 'x-memoria-bookmark-token');
  if (!expected || !got || expected === other) return false;
  const a = Buffer.from(expected), b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}
// @ts-expect-error augur-inject
hasScopedAccess = contract(hasScopedAccess, { ...augurContract_2bfd486e, contractId: 'C-7', mode: 'observe', sample: 1, where: 'server/lib/scoped-access.ts:7', rule: 'contract-wrap', id: '2bfd486e' }); /* augur-inject:contract-wrap:2bfd486e */

export function requireScope(scope: AccessScope): MiddlewareHandler {
  return async (c, next) => {
    if (!hasScopedAccess(c, scope)) return c.json({ error: `${scope} authorization required` }, 403);
    if (['POST', 'PATCH', 'PUT'].includes(c.req.method)
      && !c.req.path.endsWith('/resummarize')
      && !/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) {
      return c.json({ error: 'application/json required' }, 415);
    }
    await next();
  };
}
