import type { MiddlewareHandler } from 'hono';
import { isDirectLoopbackRequest } from '../lib/local-request.js';

/** Prevent a remote Memoria client from relaying requests into personal Tabula. */
export const localTabulaAccess: MiddlewareHandler = async (c,next) => {
  if ((process.env.MEMORIA_TABULA_MODE ?? 'local') === 'local') {
    const forwarded = [...c.req.raw.headers.keys()].some(key => key === 'forwarded' || key.startsWith('x-forwarded-') || key.startsWith('cf-'));
    if (forwarded || !isDirectLoopbackRequest(c)) return c.json({error:'local_tabula_only'},403);
  }
  await next();
};
