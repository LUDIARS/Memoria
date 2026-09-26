import {Hono} from 'hono';
import {isSameMachineRequest} from '../lib/local-request.js';

async function download(path:string):Promise<unknown> {
  const endpoint=process.env.TABULA_URL,token=process.env.TABULA_READ_TOKEN;
  if(!endpoint||!token)throw new Error('Tabula 読み取り連携が未設定です');
  const url=new URL(endpoint);
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))||url.username||url.password||url.search||url.hash)throw new Error('Tabula URL が不正です');
  if(!url.pathname.endsWith('/'))url.pathname+='/';
  const response=await fetch(new URL(`api/memoria/${path}`,url),{
    headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000),
  });
  if(!response.ok)throw new Error(`Tabula の取得に失敗しました (${response.status})`);
  return response.json();
}

export function tabulaReader():Hono {
  const r=new Hono();
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
