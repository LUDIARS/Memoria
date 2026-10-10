import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import type {TabulaImport,TabulaResult} from './client.js';
import {ensureExternalNotesSchema,importTextNote,textNoteDocument,validateTextNoteInput} from './text-note.js';

const input={external_id:'concordia-daily-goal:2026-10-09',title:'2026-10-09 のまとめ',markdown:'# 今日\n- a',source:'concordia-daily-goal'};
function db() {const d=new Database(':memory:');ensureExternalNotesSchema(d);return d;}
const count=(d:Database.Database)=>(d.prepare('SELECT COUNT(*) AS n FROM external_notes').get() as {n:number}).n;

test('the same external_id imports once and returns the existing note afterwards',async()=>{
  const d=db();
  try {
    const calls:TabulaImport[]=[];
    const importer=async(doc:TabulaImport):Promise<TabulaResult>=>{calls.push(doc);return {note:{id:'n1',title:doc.title},url:'http://tabula/n1'};};
    const first=await importTextNote(d,input,importer);
    const second=await importTextNote(d,input,importer);
    assert.equal(first.created,true);assert.equal(second.created,false);
    assert.equal(second.note.id,'n1');assert.equal(second.url,'http://tabula/n1');
    assert.equal(calls.length,1);assert.equal(count(d),1);
  } finally {d.close();}
});

test('concurrent calls with the same external_id share one Tabula import',async()=>{
  const d=db();
  try {
    let calls=0;
    const importer=async():Promise<TabulaResult>=>{calls++;await new Promise(r=>setTimeout(r,10));return {note:{id:'n2',title:'t'},url:'u2'};};
    const [a,b]=await Promise.all([importTextNote(d,input,importer),importTextNote(d,input,importer)]);
    assert.equal(calls,1);assert.equal(a.note.id,b.note.id);assert.equal([a.created,b.created].filter(Boolean).length,1);
    assert.equal(count(d),1);
  } finally {d.close();}
});

test('a failed Tabula import leaves no mapping, so a retry imports again',async()=>{
  const d=db();
  try {
    await assert.rejects(importTextNote(d,input,async()=>{throw new Error('Tabula import failed (HTTP 502)');}));
    assert.equal(count(d),0);
    const retried=await importTextNote(d,input,async()=>({note:{id:'n3',title:'t'},url:'u3'}));
    assert.equal(retried.created,true);assert.equal(count(d),1);
  } finally {d.close();}
});

test('input bounds and the Markdown document shape',()=>{
  assert.equal(validateTextNoteInput(input).ok,true);
  assert.equal(validateTextNoteInput({...input,title:'x'.repeat(201)}).ok,false);
  assert.equal(validateTextNoteInput({...input,markdown:'x'.repeat(200*1024+1)}).ok,false);
  assert.equal(validateTextNoteInput({...input,external_id:''}).ok,false);
  assert.equal(validateTextNoteInput({...input,source:'Bad Source'}).ok,false);
  assert.equal(validateTextNoteInput(null).ok,false);
  const doc=textNoteDocument(input);
  assert.deepEqual(doc.elements,[{block_type:'text',text:input.markdown}]);
  assert.equal(doc.source_ref,input.external_id);assert.deepEqual(doc.tags,['concordia-daily-goal']);
});
