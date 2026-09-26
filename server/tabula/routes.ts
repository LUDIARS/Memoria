import {Hono} from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {readFileSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {getBookmark,findBookmarkByUrl,insertBookmark,insertExternalChatMessage} from '../db.js';
import type {ChatExtractionSource,ChatExtractedMessage,NotionExtractedBlock} from '../api/types/extraction.js';
import {reparseHtml} from '../parsers/index.js';
import {importToTabula,tabulaPublicUrl} from './client.js';
import {chatDocument,notionDocument} from './extraction.js';
import {bookmarkDocument} from './bookmark-document.js';
import {tabulaReader} from './reader.js';

function source(value:unknown):value is ChatExtractionSource {return value==='chatgpt'||value==='claude'||value==='gemini';}
export function makeTabulaRouter(deps:{db:BetterSqlite3.Database;htmlDir:string}):Hono {
  const {db,htmlDir}=deps,r=new Hono();
  r.onError((error,c)=>c.json({error:error.message},502));
  r.get('/api/tabula',c=>c.json({url:tabulaPublicUrl()}));
  r.route('/api/tabula',tabulaReader());
  r.post('/api/notes/from-chat',async c=>{
    const b=await c.req.json<{source:unknown;url?:string;title?:string;conversation_id?:string;memo?:string;messages?:ChatExtractedMessage[];also_create_note?:boolean}>();
    if(!source(b.source)||!Array.isArray(b.messages)||b.messages.length>20000)return c.json({error:'invalid chat extraction'},400);
    const document=chatDocument({source:b.source,url:b.url??'',title:(b.title??'').slice(0,200),conversationId:b.conversation_id,memo:b.memo,messages:b.messages});
    // Complete the remote import first. A failed Tabula request must not appear locally successful.
    const result=b.also_create_note===false?null:await importToTabula(document);
    const messagesSaved=db.transaction(()=>{
      let count=0;for(const message of b.messages??[]) {
        if(typeof message.text!=='string'||!message.text.trim())continue;
        insertExternalChatMessage(db,{source:b.source as ChatExtractionSource,conversation_id:b.conversation_id??null,role:message.role,content:message.text,metadata:{url:b.url??'',title:b.title??'',ts:message.ts??null}});count++;
      }return count;
    })();
    return c.json({...result,note:result?.note??null,messages_saved:messagesSaved},result?201:200);
  });
  r.post('/api/notes/from-notion',async c=>{
    const b=await c.req.json<{url:string;title:string;page_id?:string;memo?:string;blocks:NotionExtractedBlock[];also_bookmark?:boolean}>();
    if(typeof b.url!=='string'||typeof b.title!=='string'||!Array.isArray(b.blocks)||b.blocks.length>20000)return c.json({error:'invalid Notion extraction'},400);
    const result=await importToTabula(notionDocument({url:b.url,title:b.title.slice(0,200),pageId:b.page_id,memo:b.memo,blocks:b.blocks}));
    let bookmarkId:number|null=null;
    if(b.also_bookmark)bookmarkId=findBookmarkByUrl(db,b.url)?.id??insertBookmark(db,{url:b.url,title:b.title,htmlPath:''});
    return c.json({...result,blocks_inserted:b.blocks.length,bookmark_id:bookmarkId},201);
  });
  r.post('/api/bookmarks/:id/reparse',async c=>{
    const id=Number(c.req.param('id'));if(!Number.isSafeInteger(id))return c.json({error:'invalid id'},400);
    const bookmark=getBookmark(db,id);if(!bookmark?.html_path)return c.json({error:'bookmark snapshot not found'},404);
    const root=realpathSync(htmlDir),path=realpathSync(resolve(root,bookmark.html_path)),rel=relative(root,path);
    if(rel.startsWith('..')||isAbsolute(rel))return c.json({error:'invalid snapshot path'},400);
    const html=readFileSync(path,'utf8'),b=await c.req.json<{kind?:'chat'|'notion';chat_source?:ChatExtractionSource;memo?:string}>();
    const result=reparseHtml(bookmark.url,html,{kind:b.kind,chat_source:b.chat_source});
    if(!result){
      const imported=await importToTabula(bookmarkDocument(bookmark,html));
      return c.json({...imported,ok:true,kind:'bookmark'},201);
    }
    const document=result.kind==='chat'?chatDocument({source:result.source,url:bookmark.url,title:result.title||bookmark.title,memo:b.memo,messages:result.messages}):notionDocument({url:bookmark.url,title:result.title||bookmark.title,pageId:result.page_id??undefined,memo:b.memo,blocks:result.blocks});
    if(!document.elements.length)return c.json({error:'snapshot contained no document'},422);
    const imported=await importToTabula({...document,snapshotHtml:html,bookmark_url:bookmark.url});
    return c.json({...imported,ok:true,kind:result.kind,blocks_inserted:document.elements.length,messages_count:result.kind==='chat'?result.messages.length:0},201);
  });
  r.all('/api/notes',c=>c.json({error:'notes_moved_to_tabula',url:tabulaPublicUrl()},410));
  r.all('/api/notes/*',c=>c.json({error:'notes_moved_to_tabula',url:tabulaPublicUrl()},410));
  return r;
}
