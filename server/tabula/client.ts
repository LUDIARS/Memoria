import { createHash } from 'node:crypto';
import { tabulaConnection,tabulaHeaders } from './connection.js';
import { localTabulaBrowserUrl } from './browser-url.js';
export interface ImportElement { block_type: string; text: string; data?: Record<string,unknown> }
export interface TabulaImport { title: string; kind?: string; tags?: string[]; source_kind?: string; source_ref?: string; bookmark_url?: string; elements: ImportElement[]; snapshotHtml?: string }
export interface TabulaResult { note: {id:string;title:string}; url:string }
export function tabulaPublicUrl():string {
  const connection=tabulaConnection();
  return connection.local?localTabulaBrowserUrl():connection.browser.href;
}
export async function importToTabula(input:TabulaImport):Promise<TabulaResult> {
  const connection=tabulaConnection();
  const bundle={note:{title:input.title,kind:input.kind??'doc',tags:input.tags??[],source_kind:input.source_kind,source_ref:input.source_ref,bookmark_url:input.bookmark_url},blocks:input.elements,snapshotHtml:input.snapshotHtml};
  // Content-derived key makes retry after an ambiguous timeout idempotent.
  const key=createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
  const endpoint=new URL(connection.local?'api/local/imports':'api/imports',connection.base);
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...tabulaHeaders(connection,'import')},body:JSON.stringify({key,bundle}),redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`Tabula import failed (HTTP ${response.status})`);
  const result=await response.json() as TabulaResult;
  if(typeof result.note?.id!=='string'||typeof result.url!=='string')throw new Error('Invalid Tabula response');
  if(connection.local)result.url=localTabulaBrowserUrl(result.note.id);
  return result;
}
