// Spec: spec/feature/tabula-extraction.md — saved bookmark registration.
import {parse} from 'node-html-parser';
import type {TabulaImport} from './client.js';

export function bookmarkDocument(bookmark:{title:string;url:string;memo:string;summary:string|null},html:string):TabulaImport {
  const root=parse(html);
  for(const node of root.querySelectorAll('script,style,noscript,template,iframe,object,form'))node.remove();
  const body=root.querySelector('article')??root.querySelector('main')??root.querySelector('body')??root;
  const text=body.structuredText.trim();
  // Plain text is escaped before the Markdown importer; the original HTML is retained separately.
  const plain=(value:string):string=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/([\\`*_{}\[\]()#+.!|~-])/g,'\\$1');
  return {title:bookmark.title.slice(0,200),kind:'bookmark',tags:['bookmark'],source_kind:'bookmark',source_ref:bookmark.url,bookmark_url:bookmark.url,
    elements:[
      {block_type:'bookmark_embed',text:'',data:{bookmark_url:bookmark.url,title:bookmark.title}},
      ...(bookmark.memo?[{block_type:'quote',text:plain(bookmark.memo)}]:[]),
      ...(bookmark.summary?[{block_type:'text',text:plain(bookmark.summary)}]:[]),
      {block_type:'text',text:plain(text)||'保存HTMLを参照してください。'},
    ],snapshotHtml:html};
}
