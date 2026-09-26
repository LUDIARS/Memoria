import {appendTabulaFeed} from './tabula-feed.js';
export async function loadTabula():Promise<void> {
  const status=document.getElementById('tabulaStatus'),link=document.getElementById('tabulaOpen') as HTMLAnchorElement|null;
  if(!status||!link)return;
  if(status.parentElement)void appendTabulaFeed(status.parentElement);
  try {
    const response=await fetch('/api/tabula');const body=await response.json() as {url?:string;error?:string};
    if(!response.ok||!body.url)throw new Error(body.error??'Tabula の接続先を取得できません');
    const url=new URL(body.url);if(!['https:','http:'].includes(url.protocol))throw new Error('Tabula の URL が不正です');
    link.href=url.href;link.hidden=false;status.textContent='ノートは Tabula に移りました。文章・図・付箋をページに書き込めます。';
  } catch(error) {link.hidden=true;status.textContent=error instanceof Error?error.message:String(error);}
}
