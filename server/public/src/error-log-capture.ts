export interface BrowserErrorEntry {at:string;kind:string;path:string;status?:number}
const entries:BrowserErrorEntry[]=[];
const subscribers=new Set<()=>void>();
export const browserErrors=():readonly BrowserErrorEntry[]=>entries;
export function onBrowserError(listener:()=>void):void {subscribers.add(listener);}
function record(entry:BrowserErrorEntry):void {
  entries.unshift(entry);if(entries.length>100)entries.length=100;
  for(const listener of subscribers)listener();
}

/** Capture this page's failures without uploading messages, document contents or tokens. */
export function installErrorCapture():void {
  const original=window.fetch.bind(window);
  window.fetch=async(input,init)=>{
    const raw=input instanceof Request?input.url:String(input);
    let url:URL;
    try {url=new URL(raw,location.href);} catch {return original(input,init);}
    const tracked=url.origin===location.origin && url.pathname!=='/api/error-log';
    const path=url.pathname.replace(/[a-zA-Z0-9_-]{40,}/g,':id').slice(0,500);
    try {
      const response=await original(input,init);
      if(tracked && !response.ok)record({at:new Date().toISOString(),kind:`${init?.method??(input instanceof Request?input.method:'GET')} 通信エラー`,path,status:response.status});
      return response;
    } catch(error) {
      if(tracked && !(error instanceof DOMException && error.name==='AbortError'))record({at:new Date().toISOString(),kind:'通信できません',path});
      throw error;
    }
  };
  window.addEventListener('error',()=>record({at:new Date().toISOString(),kind:'画面の実行エラー',path:location.pathname}));
  window.addEventListener('unhandledrejection',event=>{
    if(event.reason instanceof DOMException && event.reason.name==='AbortError')return;
    record({at:new Date().toISOString(),kind:'画面の非同期処理エラー',path:location.pathname});
  });
}
