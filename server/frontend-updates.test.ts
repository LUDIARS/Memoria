import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('worker keeps fresh same-origin UI/API requests network-only without caching private responses',async()=>{
  type FetchEvent={request:{url:string;method:string;destination:string};respondWith:(result:Promise<Response>)=>void};
  const listeners=new Map<string,(event:FetchEvent)=>void>();
  const calls:Array<{url:string;cache:string}>=[];let offline=false;
  runInNewContext(readFileSync(new URL('./public/sw.js',import.meta.url),'utf8'),{
    URL,Response,JSON,
    self:{location:{origin:'https://memoria.example'},addEventListener:(name:string,fn:(event:FetchEvent)=>void)=>listeners.set(name,fn)},
    fetch:async(request:FetchEvent['request'],options:{cache:string})=>{
      calls.push({url:request.url,cache:options.cache});
      if(offline)throw new Error('offline');return new Response('fresh');
    },
    caches:{open:()=>{throw new Error('must not cache personal responses');}},
  });
  const request=async(path:string,destination:string,method='GET'):Promise<Response|undefined>=>{
    let result:Promise<Response>|undefined;
    listeners.get('fetch')?.({request:{url:new URL(path,'https://memoria.example').href,method,destination},respondWith:value=>{result=value;}});
    return result;
  };
  for(const [path,destination] of [['/','document'],['/app.js','script'],['/style.css','style'],['/api/error-log',''],['/tabula/api/local/pages',''],['/app-version.json','']]) {
    assert.equal((await request(path,destination))?.status,200);
    assert.equal(calls.at(-1)?.cache,'no-store');
  }
  const count=calls.length;
  assert.equal(await request('https://external.example/script.js','script'),undefined);
  assert.equal(await request('/api/save','', 'POST'),undefined);
  assert.equal(calls.length,count);
  offline=true;
  const api=await request('/tabula/api/local/pages','');assert.equal(api?.status,503);
  assert.deepEqual(await api?.json(),{error:'offline'});
  const page=await request('/','document');assert.equal(page?.status,503);
  assert.match(page?.headers.get('content-type')??'',/text\/plain/);
});
