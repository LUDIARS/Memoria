import assert from 'node:assert/strict';
import test from 'node:test';
import {Hono} from 'hono';
import {tabulaConnection,tabulaHeaders} from './connection.js';
import {localTabulaAccess} from './local-access.js';

test('local browser and import responses retain absolute URL compatibility over Access',async()=>{
  const previous=process.env.MEMORIA_TABULA_MODE;process.env.MEMORIA_TABULA_MODE='local';
  try {
    const app=new Hono();app.use('*',localTabulaAccess);
    app.get('/api/tabula',c=>c.json({url:'/tabula/#workspace=local',mode:'local'}));
    app.post('/api/ai/articles/1/transcribe',c=>c.json({url:'/tabula/#workspace=local&page=note-1',note:{id:'note-1'}},201));
    const env={incoming:{socket:{remoteAddress:'127.0.0.1'}}};
    const headers={origin:'https://memoria.ai-run-do.com','x-forwarded-proto':'https'};
    const config=await app.request('http://memoria.ai-run-do.com/api/tabula',{headers},env);
    assert.equal((await config.json() as {url:string}).url,'https://memoria.ai-run-do.com/tabula/#workspace=local');
    const imported=await app.request('http://memoria.ai-run-do.com/api/ai/articles/1/transcribe',{method:'POST',headers},env);
    assert.equal(imported.status,201);
    const body=await imported.json() as {url:string;note:{id:string}};assert.equal(new URL(body.url).origin,'https://memoria.ai-run-do.com');assert.equal(body.note.id,'note-1');
    const direct=await app.request('http://127.0.0.1:5180/api/tabula',{},env);
    assert.equal((await direct.json() as {url:string}).url,'http://127.0.0.1:5180/tabula/#workspace=local');
  } finally {if(previous===undefined)delete process.env.MEMORIA_TABULA_MODE;else process.env.MEMORIA_TABULA_MODE=previous;}
});

test('local Tabula uses the catalog endpoint without shared credentials',()=>{
  const connection=tabulaConnection({MEMORIA_TABULA_URL:'http://127.0.0.1:5197',TABULA_URL:'https://shared.example'});
  assert.equal(connection.local,true);
  assert.equal(connection.base.href,'http://127.0.0.1:5197/');
  assert.equal(connection.browser.hash,'#workspace=local');
  assert.deepEqual(tabulaHeaders(connection,'import',{}),{Origin:'http://127.0.0.1:5197'});
  assert.throws(()=>tabulaConnection({TABULA_URL:'https://shared.example'}),/MEMORIA_TABULA_URL/);
  assert.throws(()=>tabulaConnection({MEMORIA_TABULA_URL:'https://remote.example'}),/Invalid/);
  assert.throws(()=>tabulaConnection({MEMORIA_TABULA_URL:'http://user:pass@localhost:5197'}),/Invalid/);
  assert.throws(()=>tabulaConnection({MEMORIA_TABULA_MODE:'typo'}),/Invalid/);
});

test('explicit shared mode preserves distinct import and read credentials',()=>{
  const connection=tabulaConnection({MEMORIA_TABULA_MODE:'shared',TABULA_URL:'https://shared.example',TABULA_PUBLIC_URL:'https://shared.example'});
  const env={TABULA_IMPORT_TOKEN:'import-only',TABULA_READ_TOKEN:'read-only'};
  assert.deepEqual(tabulaHeaders(connection,'read',env),{Authorization:'Bearer read-only'});
  assert.deepEqual(tabulaHeaders(connection,'import',env),{Authorization:'Bearer import-only'});
  assert.throws(()=>tabulaHeaders(connection,'read',{}),/token is required/);
});

test('personal relay accepts the Access proxy but rejects remote peers, unknown hosts and cross-origin requests',async()=>{
  const previous=process.env.MEMORIA_TABULA_MODE;
  process.env.MEMORIA_TABULA_MODE='local';
  try {
    const app=new Hono();app.get('/notes',localTabulaAccess,c=>c.json({ok:true}));
    const env={incoming:{socket:{remoteAddress:'127.0.0.1'}}};
    assert.equal((await app.request('http://127.0.0.1:5180/notes',{},env)).status,200);
    assert.equal((await app.request('http://127.0.0.1:5180/notes',{}, {incoming:{socket:{remoteAddress:'192.0.2.1'}}})).status,403);
    assert.equal((await app.request('http://127.0.0.1:5180/notes',{headers:{origin:'https://remote.example'}},env)).status,403);
    const forwarded={origin:'https://memoria.ai-run-do.com','x-forwarded-proto':'https','cf-connecting-ip':'192.0.2.1','sec-fetch-site':'same-origin'};
    assert.equal((await app.request('http://memoria.ai-run-do.com/notes',{headers:forwarded},env)).status,200);
    assert.equal((await app.request('http://memoria.ai-run-do.com/notes',{headers:forwarded},{incoming:{socket:{remoteAddress:'192.0.2.1'}}})).status,403);
    assert.equal((await app.request('http://unknown.example/notes',{},env)).status,403);
    assert.equal((await app.request('http://memoria.ai-run-do.com/notes',{headers:{...forwarded,origin:'https://evil.example'}},env)).status,403);
    assert.equal((await app.request('http://memoria.ai-run-do.com/notes',{headers:{...forwarded,'sec-fetch-site':'cross-site'}},env)).status,403);
    assert.equal((await app.request('http://memoria.ai-run-do.com/notes',{headers:forwarded})).status,403);
  } finally {if(previous===undefined)delete process.env.MEMORIA_TABULA_MODE;else process.env.MEMORIA_TABULA_MODE=previous;}
});
