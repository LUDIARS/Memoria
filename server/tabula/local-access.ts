import type { MiddlewareHandler } from 'hono';
import { isSameMachineRequest } from '../lib/local-request.js';
import {absoluteTabulaResponse} from './browser-response.js';

/** Access authenticates the configured public host; verify the local proxy peer and Origin. */
export const localTabulaAccess: MiddlewareHandler = async (c,next) => {
  if ((process.env.MEMORIA_TABULA_MODE ?? 'local') === 'local') {
    const site=c.req.header('sec-fetch-site');
    if (!isSameMachineRequest(c) || (site && site!=='same-origin' && site!=='none'))
      return c.json({error:'local_tabula_only'},403);
  }
  await next();
  if ((process.env.MEMORIA_TABULA_MODE ?? 'local') === 'local') await absoluteTabulaResponse(c);
};
