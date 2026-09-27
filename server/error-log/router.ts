import {Hono} from 'hono';
import type {MiddlewareHandler} from 'hono';
import {isSameMachineRequest} from '../lib/local-request.js';
import type {ErrorLogStore} from './store.js';

export function captureHttpErrors(store:ErrorLogStore):MiddlewareHandler {
  return async(c,next)=>{
    let failed=false;
    try {await next();} catch(error) {failed=true;throw error;}
    finally {
      const status=failed?500:c.res.status;
      if(status>=400 && c.req.path!=='/api/error-log') {
        // Diagnostics must not turn the original request into a second failure.
        try {store.record(c.req.method,c.req.path,status);} catch { /* original HTTP response remains authoritative */ }
      }
    }
  };
}

export function errorLogRouter(store:ErrorLogStore):Hono {
  const r=new Hono();
  r.get('/api/error-log',c=>{
    if(!isSameMachineRequest(c))return c.json({error:'local_only'},403);
    c.header('Cache-Control','no-store');
    return c.json({items:store.list()});
  });
  return r;
}
