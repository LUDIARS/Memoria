import { createHash } from 'node:crypto';
export interface ImportElement { block_type: string; text: string; data?: Record<string,unknown> }
export interface TabulaImport { title: string; kind?: string; tags?: string[]; source_kind?: string; source_ref?: string; bookmark_url?: string; elements: ImportElement[]; snapshotHtml?: string }
export interface TabulaResult { note: {id:string;title:string}; url:string }
export function tabulaPublicUrl():string {
  const raw=process.env.TABULA_PUBLIC_URL?.trim();
  if(!raw)throw new Error('TABULA_PUBLIC_URL is required; configure the Tabula browser URL');
  const url=new URL(raw);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid TABULA_PUBLIC_URL');
  return url.href;
}
export async function importToTabula(input:TabulaImport):Promise<TabulaResult> {
  const raw=process.env.TABULA_URL?.trim(),token=process.env.TABULA_IMPORT_TOKEN?.trim();
  if(!raw||!token)throw new Error('Tabula integration requires TABULA_URL and TABULA_IMPORT_TOKEN');
  const base=new URL(raw);
  if(!['https:','http:'].includes(base.protocol)||base.username||base.password)throw new Error('Invalid TABULA_URL');
  if(base.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw new Error('Tabula integration requires HTTPS outside loopback');
  const bundle={note:{title:input.title,kind:input.kind??'doc',tags:input.tags??[],source_kind:input.source_kind,source_ref:input.source_ref,bookmark_url:input.bookmark_url},blocks:input.elements,snapshotHtml:input.snapshotHtml};
  // Content-derived key makes retry after an ambiguous timeout idempotent.
  const key=createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
  const endpoint=new URL('api/imports',base.href.endsWith('/')?base:new URL(base.href+'/'));
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({key,bundle}),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`Tabula import failed (HTTP ${response.status})`);
  const result=await response.json() as TabulaResult;
  if(typeof result.note?.id!=='string'||typeof result.url!=='string')throw new Error('Invalid Tabula response');
  return result;
}
