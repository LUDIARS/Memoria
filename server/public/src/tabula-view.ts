import {appendTabulaFeed} from './tabula-feed.js';
export async function loadTabula():Promise<void> {
  const status=document.getElementById('tabulaStatus'),link=document.getElementById('tabulaOpen') as HTMLAnchorElement|null;
  if(!status||!link)return;
  if(status.parentElement)void appendTabulaFeed(status.parentElement);
  try {
    const response=await fetch('/api/tabula');const body=await response.json() as {url?:string;mode?:string;error?:string};
    if(!response.ok||!body.url)throw new Error(body.error??'Tabula の接続先を取得できません');
    const url=new URL(body.url,location.href);if(!['https:','http:'].includes(url.protocol))throw new Error('Tabula の URL が不正です');
    link.href=url.href;link.hidden=false;status.textContent=body.mode==='local'?'この端末のTabulaを開きます。ログインせずに自分用のメモを保存できます。':'Tabulaの共有ワークスペースを開きます。';
  } catch(error) {link.hidden=true;status.textContent=error instanceof Error?error.message:String(error);}
}
