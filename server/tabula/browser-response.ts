import type {Context} from 'hono';

/** Preserve the absolute-URL API contract for already-open and external clients. */
export async function absoluteTabulaResponse(c:Context):Promise<void> {
  const path=c.req.path;
  const hasLink=path==='/api/tabula' || /^\/api\/notes(?:\/|$)/.test(path)
    || /^\/api\/bookmarks\/\d+\/reparse$/.test(path)
    || /^\/api\/ai\/articles\/\d+\/transcribe$/.test(path);
  if(!hasLink || !c.res.headers.get('content-type')?.includes('application/json'))return;
  const body=await c.res.clone().json() as Record<string,unknown>;
  if(typeof body.url!=='string' || !body.url.startsWith('/tabula/'))return;
  const origin=new URL(c.req.url);
  const protocol=c.req.header('x-forwarded-proto')?.split(',',1)[0].trim().toLowerCase();
  if(protocol==='http'||protocol==='https')origin.protocol=`${protocol}:`;
  body.url=new URL(body.url,origin).href;
  const headers=new Headers(c.res.headers);headers.delete('content-length');headers.delete('etag');
  c.res=new Response(JSON.stringify(body),{status:c.res.status,headers});
}
