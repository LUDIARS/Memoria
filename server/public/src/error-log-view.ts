import {browserErrors,onBrowserError,installErrorCapture} from './error-log-capture.js';
interface ServerError {id:number;occurred_at:string;method:string;path:string;status:number}
let serverEntries:ServerError[]=[];
let loading:Promise<void>|null=null;

function render():void {
  const list=document.getElementById('errorLogList');if(!list)return;
  list.replaceChildren();
  const items=[...browserErrors().map(e=>({at:e.at,label:`この画面 · ${e.kind}`,path:e.path,status:e.status})),
    ...serverEntries.map(e=>({at:e.occurred_at,label:`サーバ · ${e.method}`,path:e.path,status:e.status}))]
    .sort((a,b)=>b.at.localeCompare(a.at));
  for(const entry of items) {
    const item=document.createElement('li'),time=document.createElement('time'),title=document.createElement('strong'),detail=document.createElement('div');
    time.dateTime=entry.at;time.textContent=new Date(entry.at).toLocaleString();
    title.textContent=` ${entry.label}${entry.status?` · HTTP ${entry.status}`:''}`;
    detail.textContent=entry.path;item.append(time,title,detail);list.append(item);
  }
  const empty=document.getElementById('errorLogEmpty');if(empty)empty.hidden=items.length>0;
}

export function loadErrorLog():Promise<void> {
  if(loading)return loading;
  loading=(async()=>{
    const status=document.getElementById('errorLogStatus');
    try {
      const response=await fetch('/api/error-log',{cache:'no-store'});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const body=await response.json() as {items:ServerError[]};serverEntries=body.items;
      if(status)status.textContent='サーバの最新200件と、この画面で発生したエラーを表示しています。';
    } catch {
      if(status)status.textContent='サーバのエラー履歴を取得できません。この画面のエラーを表示しています。';
    } finally {render();loading=null;}
  })();
  return loading;
}

export function setupErrorLog(open:()=>void):void {
  installErrorCapture();
  const button=document.getElementById('openErrorLog');
  button?.addEventListener('click',()=>{open();if(button)button.hidden=true;});
  document.getElementById('errorLogRefresh')?.addEventListener('click',()=>void loadErrorLog());
  onBrowserError(()=>{
    if(button){button.hidden=false;button.textContent=`エラーを確認 (${browserErrors().length})`;}
    render();
  });
}
