import assert from 'node:assert/strict';
import test from 'node:test';
import {Hono} from 'hono';
import {tabulaConnection,tabulaHeaders} from './connection.js';
import {localTabulaAccess} from './local-access.js';

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

test('personal Tabula relay rejects remote clients, forwarding and cross-origin requests',async()=>{
  const previous=process.env.MEMORIA_TABULA_MODE;
  process.env.MEMORIA_TABULA_MODE='local';
  try {
    const app=new Hono();app.get('/notes',localTabulaAccess,c=>c.json({ok:true}));
    const env={incoming:{socket:{remoteAddress:'127.0.0.1'}}};
    assert.equal((await app.request('http://127.0.0.1:5180/notes',{},env)).status,200);
    assert.equal((await app.request('http://127.0.0.1:5180/notes',{}, {incoming:{socket:{remoteAddress:'192.0.2.1'}}})).status,403);
    assert.equal((await app.request('http://127.0.0.1:5180/notes',{headers:{origin:'https://remote.example'}},env)).status,403);
    assert.equal((await app.request('http://127.0.0.1:5180/notes',{headers:{'x-forwarded-for':'127.0.0.1'}},env)).status,403);
  } finally {if(previous===undefined)delete process.env.MEMORIA_TABULA_MODE;else process.env.MEMORIA_TABULA_MODE=previous;}
});
