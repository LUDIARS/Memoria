import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {Hono} from 'hono';
import {ErrorLogStore} from './store.js';
import {captureHttpErrors,errorLogRouter} from './router.js';

test('HTTP errors persist without secrets, are bounded, and require trusted browser access',async()=>{
  const db=new Database(':memory:');
  try {
    const store=new ErrorLogStore(db),app=new Hono();
    app.use('*',captureHttpErrors(store));app.route('/',errorLogRouter(store));
    app.get('/fail',c=>c.json({error:'private body'},403));
    app.get('/ok',c=>c.text('ok'));
    const env={incoming:{socket:{remoteAddress:'127.0.0.1'}}};
    await app.request('http://localhost/fail?token=secret',{},env);
    await app.request('http://localhost/ok',{},env);
    assert.equal(store.list().length,1);assert.equal(store.list()[0].path,'/fail');
    assert.equal(store.list()[0].status,403);assert.doesNotMatch(JSON.stringify(store.list()),/secret|private body/);
    const read=await app.request('http://memoria.ai-run-do.com/api/error-log',{headers:{origin:'https://memoria.ai-run-do.com','x-forwarded-proto':'https'}},env);
    assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');
    assert.equal((await app.request('http://localhost/api/error-log',{}, {incoming:{socket:{remoteAddress:'192.0.2.1'}}})).status,403);
    assert.equal(store.list().length,1,'error log read failures do not recursively record');
    for(let i=0;i<510;i++)store.record('GET',`/route/${i}`,500);
    assert.equal(store.list().length,200);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM app_http_errors').get() as {n:number}).n,500);
    const reopened=new ErrorLogStore(db);assert.equal(reopened.list()[0].path,'/route/509');
  } finally {db.close();}
});
