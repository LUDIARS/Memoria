import assert from 'node:assert/strict';
import test from 'node:test';
import {Hono} from 'hono';
import {tabulaBrowserProxy} from './browser-proxy.js';
import {localTabulaBrowserUrl} from './browser-url.js';

test('Access-protected editor uses isolated local APIs and preserves response security',async()=>{
  const keys=['MEMORIA_TABULA_MODE','MEMORIA_TABULA_URL','TABULA_URL','TABULA_PUBLIC_URL'];
  const previous=new Map(keys.map(key=>[key,process.env[key]]));
  process.env.MEMORIA_TABULA_MODE='local';process.env.MEMORIA_TABULA_URL='http://127.0.0.1:5197';
  try {
    const calls:Array<{url:URL;init:RequestInit}> = [];
    const fetcher:typeof fetch=async(input,init)=>{
      const url=new URL(String(input));calls.push({url,init:init??{}});
      if(url.pathname==='/api/session')return Response.json({identity:{id:'local'},mode:'local',loginAvailable:true});
      return new Response(url.pathname.endsWith('/snapshot')?'<script>unsafe()</script>':'editor',{
        status:200,headers:{'content-type':'text/html','etag':'"2"','set-cookie':'upstream=secret','access-control-allow-origin':'*'},
      });
    };
    const app=new Hono();app.route('/',tabulaBrowserProxy(fetcher));app.get('/unrelated',c=>c.text('unaffected'));
    const env={incoming:{socket:{remoteAddress:'127.0.0.1'}}};
    const headers={origin:'https://memoria.ai-run-do.com','x-forwarded-proto':'https','cf-connecting-ip':'192.0.2.1','sec-fetch-site':'same-origin'};
    const request=(path:string,init:RequestInit={})=>app.request(`http://memoria.ai-run-do.com${path}`,{...init,headers:{...headers,...init.headers}},env);
    assert.equal((await request('/tabula')).headers.get('location'),'/tabula/');
    const html=await request('/tabula/');assert.equal(html.status,200);assert.equal(calls.at(-1)?.url.href,'http://127.0.0.1:5197/');
    assert.equal(html.headers.get('set-cookie'),null);assert.equal(html.headers.get('access-control-allow-origin'),null);
    assert.equal(html.headers.get('cache-control'),'no-store');
    assert.equal((await request('/tabula/main.js')).status,200);
    const session=await request('/tabula/api/session?workspace=shared');
    assert.deepEqual(await session.json(),{identity:{id:'local'},mode:'local',loginAvailable:false});
    assert.equal(calls.at(-1)?.url.searchParams.get('workspace'),'local');
    const body=JSON.stringify({title:'note',visibility:'private'});
    const saved=await request('/tabula/api/local/pages/page-1',{method:'PUT',body,headers:{'content-type':'application/json','if-match':'"1"',authorization:'Bearer private',cookie:'CF_Authorization=private','forwarded':'for=192.0.2.1'}});
    assert.equal(saved.status,200);assert.equal(saved.headers.get('etag'),'"2"');
    const upstream=calls.at(-1);assert.ok(upstream);
    assert.equal(Buffer.from(upstream.init.body as ArrayBuffer).toString('utf8'),body);
    const sent=new Headers(upstream.init.headers);
    assert.equal(sent.get('origin'),'http://127.0.0.1:5197');assert.equal(sent.get('if-match'),'"1"');
    for(const name of ['cookie','authorization','forwarded','x-forwarded-proto','cf-connecting-ip','host'])assert.equal(sent.get(name),null);
    const snapshot=await request('/tabula/api/local/pages/page-1/snapshot');
    assert.match(snapshot.headers.get('content-security-policy')??'',/^sandbox;/);
    const count=calls.length;
    for(const path of ['api/pages','api/imports','api/local/imports','api/session/config','api/session/complete','api/admin','%2fapi%2fpages','.env'])
      assert.equal((await request(`/tabula/${path}`)).status,404,path);
    assert.equal((await request('/tabula/api/local/pages',{method:'POST',headers:{origin:'https://evil.example'},body})).status,403);
    assert.equal((await app.request('http://memoria.ai-run-do.com/tabula/api/local/pages',{method:'POST',body},env)).status,403);
    assert.equal((await app.request('http://memoria.ai-run-do.com/tabula/',{headers},{incoming:{socket:{remoteAddress:'192.0.2.1'}}})).status,403);
    assert.equal(calls.length,count);
    assert.equal((await app.request('http://unknown.example/unrelated')).status,200);
    const failure=tabulaBrowserProxy(async()=>{throw new Error('private upstream detail');});
    const failed=await failure.request('http://127.0.0.1/tabula/',{},env);
    assert.equal(failed.status,502);assert.doesNotMatch(await failed.text(),/private upstream/);
    process.env.MEMORIA_TABULA_MODE='shared';process.env.TABULA_URL='https://shared.example';process.env.TABULA_PUBLIC_URL='https://shared.example';
    assert.equal((await request('/tabula/')).status,404);
  } finally {
    for(const [key,value] of previous) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});

test('local editor links stay on Memoria and encode page identifiers',()=>{
  assert.equal(localTabulaBrowserUrl(),'/tabula/#workspace=local');
  const url=new URL(localTabulaBrowserUrl('page & 1'),'https://memoria.ai-run-do.com');
  assert.equal(url.origin,'https://memoria.ai-run-do.com');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('page'),'page & 1');
});
