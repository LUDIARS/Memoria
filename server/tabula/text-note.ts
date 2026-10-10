// Spec: spec/feature/local-tabula.md — Markdown text import (POST /api/notes/from-text).
// external_notes maps a caller's external_id to the Tabula note, so a retry never creates a second note.
import type BetterSqlite3 from 'better-sqlite3';
import type {TabulaImport,TabulaResult} from './client.js';
import { contract } from '../shared/contract-runtime.js'; /* augur-inject:import:54dea0e6 */
import augurContract_34f49a48 from '../../augur/contracts/text-note-import.contract.js'; /* augur-inject:contract-predicate:d8168618 */

type Db=BetterSqlite3.Database;
export const MAX_TEXT_NOTE_TITLE_CHARS=200;
export const MAX_TEXT_NOTE_MARKDOWN_BYTES=200*1024;
export interface TextNoteInput {external_id:string;title:string;markdown:string;source:string}
export interface TextNoteResult {note:{id:string};url:string;external_id:string;created:boolean}

export function ensureExternalNotesSchema(db:Db):void {
  db.exec(`CREATE TABLE IF NOT EXISTS external_notes (
    external_id TEXT PRIMARY KEY, source TEXT NOT NULL, note_id TEXT NOT NULL,
    note_url TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

export function validateTextNoteInput(body:unknown):{ok:true;input:TextNoteInput}|{ok:false;error:string} {
  const b=(body??{}) as Record<string,unknown>;
  if(typeof b.external_id!=='string'||!b.external_id.trim()||b.external_id.length>200)return {ok:false,error:'external_id must be 1..200 chars'};
  if(typeof b.source!=='string'||!/^[a-z0-9-]{1,64}$/.test(b.source))return {ok:false,error:'invalid source'};
  if(typeof b.title!=='string'||!b.title.trim())return {ok:false,error:'title is required'};
  if(b.title.length>MAX_TEXT_NOTE_TITLE_CHARS)return {ok:false,error:`title exceeds ${MAX_TEXT_NOTE_TITLE_CHARS} chars`};
  if(typeof b.markdown!=='string'||!b.markdown.trim())return {ok:false,error:'markdown is required'};
  if(Buffer.byteLength(b.markdown,'utf8')>MAX_TEXT_NOTE_MARKDOWN_BYTES)return {ok:false,error:'markdown exceeds 200KB'};
  return {ok:true,input:{external_id:b.external_id,title:b.title,markdown:b.markdown,source:b.source}};
}

/** Text blocks go through Tabula's Markdown importer, so the body is passed as-is. */
export function textNoteDocument(input:TextNoteInput):TabulaImport {
  return {title:input.title,kind:'doc',tags:[input.source],source_kind:'text',source_ref:input.external_id,elements:[{block_type:'text',text:input.markdown}]};
}

function mapped(db:Db,externalId:string):{note_id:string;note_url:string}|undefined {
  return db.prepare('SELECT note_id, note_url FROM external_notes WHERE external_id = ?').get(externalId) as {note_id:string;note_url:string}|undefined;
}

const inflight=new Map<string,Promise<TextNoteResult>>();

/** Import once per external_id. The mapping is written only after Tabula accepted the note. */
export async function importTextNote(db:Db,input:TextNoteInput,importer:(doc:TabulaImport)=>Promise<TabulaResult>):Promise<TextNoteResult> {
  const existing=mapped(db,input.external_id);
  if(existing)return {note:{id:existing.note_id},url:existing.note_url,external_id:input.external_id,created:false};
  // Concurrent calls with the same external_id share one import instead of racing to Tabula.
  const pending=inflight.get(input.external_id);
  if(pending)return pending.then(result=>({...result,created:false}));
  const run=(async():Promise<TextNoteResult>=>{
    const result=await importer(textNoteDocument(input));
    db.prepare('INSERT OR IGNORE INTO external_notes (external_id, source, note_id, note_url) VALUES (?, ?, ?, ?)')
      .run(input.external_id,input.source,result.note.id,result.url);
    const row=mapped(db,input.external_id) as {note_id:string;note_url:string};
    return {note:{id:row.note_id},url:row.note_url,external_id:input.external_id,created:row.note_id===result.note.id};
  })();
  inflight.set(input.external_id,run);
  try {return await run;} finally {inflight.delete(input.external_id);}
}
// @ts-expect-error augur-inject
importTextNote = contract(importTextNote, { ...augurContract_34f49a48, contractId: 'C-14', mode: 'observe', sample: 1, where: 'server/tabula/text-note.ts:42', rule: 'contract-wrap', id: '34f49a48' }); /* augur-inject:contract-wrap:34f49a48 */
