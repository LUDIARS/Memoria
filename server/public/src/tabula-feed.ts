interface Summary {id:string;title:string;ownerName:string;updatedAt:string}
let generation=0;
const active=new Set<AbortController>();
export function tabulaIncluded():boolean {
  return (document.getElementById('tabulaInclude') as HTMLInputElement|null)?.checked??false;
}
function status(message:string):void {
  const el=document.getElementById('tabulaFeedStatus');if(el)el.textContent=message;
}
export function setupTabulaFeed(refresh:()=>void):void {
  document.getElementById('tabulaInclude')?.addEventListener('change',()=>{
    generation++;
    for(const controller of active)controller.abort();
    active.clear();
    document.querySelectorAll('[data-tabula-feed]').forEach(el=>el.remove());
    status(tabulaIncluded()?'Tabulaを取得します':'');
    refresh();
  });
}
async function json<T>(url:string):Promise<T> {
  const controller=new AbortController();active.add(controller);
  const timeout=setTimeout(()=>controller.abort(),20000);
  try {
    const response=await fetch(url,{signal:controller.signal,cache:'no-store'});
    if(!response.ok)throw new Error(`Tabulaの取得に失敗しました (${response.status})`);
    return await response.json() as T;
  } finally {clearTimeout(timeout);active.delete(controller);}
}
function button(label:string):HTMLButtonElement {
  const el=document.createElement('button');el.type='button';el.textContent=label;return el;
}

/** Add shared documents alongside local content; never replace or persist local records. */
export async function appendTabulaFeed(parent:HTMLElement,query=''):Promise<void> {
  parent.querySelectorAll('[data-tabula-feed]').forEach(el=>el.remove());
  if(!tabulaIncluded())return;
  const epoch=generation,panel=document.createElement('section');
  panel.dataset.tabulaFeed='';panel.className='tabula-feed';parent.append(panel);
  const current=()=>epoch===generation&&tabulaIncluded()&&panel.isConnected;
  const heading=document.createElement('h3');heading.textContent='Tabulaの共有記事';panel.append(heading);
  const message=document.createElement('p');panel.append(message);
  let publicUrl:URL|null=null;
  try {
    const config=await json<{url:string}>('/api/tabula');
    const url=new URL(config.url);
    if(['http:','https:'].includes(url.protocol))publicUrl=url;
  } catch { /* Reading remains available if the external editor URL is unavailable. */ }
  async function load(offset:number):Promise<void> {
    if(!current())return;
    message.textContent='取得中…';
    try {
      const result=await json<{items:Summary[];nextOffset:number|null}>(`/api/tabula/pages?${new URLSearchParams({q:query,offset:String(offset)})}`);
      if(!current())return;
      for(const page of result.items){
        const card=document.createElement('article');card.className='ai-card';
        const title=document.createElement('h4');title.textContent=page.title;
        const meta=document.createElement('p');meta.textContent=`Tabula · ${page.ownerName??''} · ${page.updatedAt??''}`;
        const read=button('本文を表示');card.append(title,meta,read);
        read.addEventListener('click',async()=>{
          read.disabled=true;
          try {
            const detail=await json<{document:{html:string}}>(`/api/tabula/pages/${encodeURIComponent(page.id)}`);
            if(!current())return;
            const frame=document.createElement('iframe');frame.title=page.title;frame.setAttribute('sandbox','');
            frame.style.cssText='width:100%;height:420px;border:0;background:white';
            frame.srcdoc=`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><style>body{font:16px sans-serif;overflow-wrap:anywhere}</style>${detail.document.html}`;
            card.append(frame);read.remove();
          } catch(error){if(current()){read.disabled=false;message.textContent=String(error);}}
        });
        if(publicUrl){
          const link=document.createElement('a'),url=new URL(publicUrl);url.hash=`page=${encodeURIComponent(page.id)}`;
          link.href=url.href;link.textContent='Tabulaで編集';link.target='_blank';link.rel='noopener noreferrer';card.append(link);
        }
        panel.append(card);
      }
      message.textContent=result.items.length?'':'共有記事はありません';status('');
      if(Number.isSafeInteger(result.nextOffset)&&result.nextOffset!>offset){
        const more=button('Tabulaの記事をさらに取得');panel.append(more);
        more.addEventListener('click',()=>{more.remove();void load(result.nextOffset!);});
      }
    } catch(error){if(current()){message.textContent=String(error);status('Tabula取得エラー');const retry=button('再取得');panel.append(retry);retry.onclick=()=>{retry.remove();void load(offset);};}}
  }
  await load(0);
}
