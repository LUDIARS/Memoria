import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {localTabulaAccess} from './local-access.js';
import {tabulaConnection} from './connection.js';

/** Only personal editor assets and document APIs; no shared login/import/admin relay. */
function allowedPath(path:string,method:string):boolean {
  if(method==='GET' || method==='HEAD') {
    if(/^(?:index\.html|[a-zA-Z0-9_-]+\.(?:js|css))?$/.test(path))return true;
    if(path==='api/session')return true;
  }
  if(!['GET','POST','PUT','DELETE','HEAD'].includes(method))return false;
  return /^api\/local\/pages(?:\/[a-zA-Z0-9_-]+(?:\/(?:snapshot|history(?:\/\d+)?|comments(?:\/[a-zA-Z0-9_-]+)?))?)?\/?$/.test(path);
}

const editorPolicy="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";

export function tabulaBrowserProxy(fetcher:typeof fetch=fetch):Hono {
  const r=new Hono();
  r.use('/tabula',localTabulaAccess);
  r.use('/tabula/*',localTabulaAccess);
  r.use('/tabula/*',bodyLimit({maxSize:12*1024*1024,onError:c=>c.json({error:'request_too_large'},413)}));
  r.get('/tabula',c=>c.redirect('/tabula/'));
  r.all('/tabula/*',async c=>{
    const connection=tabulaConnection();
    if(!connection.local)return c.json({error:'local_tabula_disabled'},404);
    const path=c.req.path.slice('/tabula/'.length),method=c.req.method;
    if(!allowedPath(path,method))return c.json({error:'tabula_route_not_found'},404);
    const mutation=!['GET','HEAD'].includes(method);
    if(mutation && !c.req.header('origin'))return c.json({error:'origin_required'},403);
    const upstream=new URL(path,connection.base);
    upstream.search=new URL(c.req.url).search;
    if(path==='api/session')upstream.searchParams.set('workspace','local');
    // The validated Memoria boundary is the authority, never forwarded browser credentials.
    const headers=new Headers({Origin:connection.base.origin});
    for(const name of ['content-type','if-match']) {
      const value=c.req.header(name);if(value)headers.set(name,value);
    }
    let response:Response;
    try {
      response=await fetcher(upstream,{method,headers,body:mutation?await c.req.arrayBuffer():undefined,
        redirect:'error',signal:AbortSignal.timeout(20000)});
    } catch {return c.json({error:'Tabula に接続できません'},502);}
    const output=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    for(const name of ['content-type','etag']) {
      const value=response.headers.get(name);if(value)output.set(name,value);
    }
    // Snapshots are untrusted imported HTML: preserve their sandbox, not the editor policy.
    output.set('Content-Security-Policy',/\/snapshot\/?$/.test(path)
      ? "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"
      : editorPolicy);
    if(path==='api/session' && method==='GET' && response.ok) {
      const session=await response.json() as Record<string,unknown>;
      return new Response(JSON.stringify({...session,mode:'local',loginAvailable:false}),{status:response.status,headers:output});
    }
    return new Response(response.body,{status:response.status,headers:output});
  });
  return r;
}
