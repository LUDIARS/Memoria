import {Hono} from 'hono';
import {isSameMachineRequest} from '../lib/local-request.js';
import {tabulaConnection,tabulaHeaders} from './connection.js';
import {localTabulaAccess} from './local-access.js';

async function download(path:string):Promise<unknown> {
  const connection=tabulaConnection();
  const response=await fetch(new URL(`${connection.local?'api/local/memoria':'api/memoria'}/${path}`,connection.base),{
    headers:tabulaHeaders(connection,'read'),redirect:'error',signal:AbortSignal.timeout(15000),
  });
  if(!response.ok)throw new Error(`Tabula の取得に失敗しました (${response.status})`);
  return response.json();
}

export function tabulaReader():Hono {
  const r=new Hono();
  r.use('*',localTabulaAccess);
  r.use('*',async(c,next)=>{
    if(!isSameMachineRequest(c))return c.json({error:'local_only'},403);
    c.header('Cache-Control','no-store');
    await next();
  });
  r.get('/pages',async c=>{
    const offset=Number(c.req.query('offset')??0);
    if(!Number.isSafeInteger(offset)||offset<0)return c.json({error:'invalid offset'},400);
    const params=new URLSearchParams({offset:String(offset),q:(c.req.query('q')??'').slice(0,200)});
    return c.json(await download(`pages?${params}`));
  });
  r.get('/pages/:id',async c=>{
    const id=c.req.param('id');
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))return c.json({error:'invalid id'},400);
    return c.json(await download(`pages/${encodeURIComponent(id)}`));
  });
  return r;
}
