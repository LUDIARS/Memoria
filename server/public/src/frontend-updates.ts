let registration:Promise<ServiceWorkerRegistration>|null=null;
export function registerMemoriaWorker():Promise<ServiceWorkerRegistration> {
  if(!('serviceWorker' in navigator))return Promise.reject(new Error('この端末は Service Worker 非対応です'));
  if(!registration)registration=navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'})
    .catch(error=>{registration=null;throw error;});
  return registration;
}

/** Refresh only on explicit user action: note drafts must survive update detection. */
export function setupFrontendUpdates():void {
  const button=document.getElementById('frontendUpdate');
  const show=():void=>{if(button)button.hidden=false;};
  button?.addEventListener('click',()=>{
    if(confirm('未保存の入力を保存しましたか？ 最新の画面を読み込みます。'))location.reload();
  });
  const hadController='serviceWorker' in navigator && navigator.serviceWorker.controller!==null;
  if('serviceWorker' in navigator)navigator.serviceWorker.addEventListener('controllerchange',()=>{if(hadController)show();});
  let knownVersion:string|null=null,checking=false,timer:ReturnType<typeof setInterval>|null=null;
  const check=async():Promise<void>=>{
    if(document.hidden || checking)return;
    checking=true;
    try {
      const response=await fetch('/app-version.json',{cache:'no-store'});
      if(response.ok) {
        const body=await response.json() as {version?:string};
        if(typeof body.version==='string' && /^[a-f0-9]{64}$/.test(body.version)) {
          if(knownVersion && body.version!==knownVersion)show();
          knownVersion=body.version;
        }
      }
      if('serviceWorker' in navigator)await (await registerMemoriaWorker()).update();
    } catch { /* Offline/unsupported update checks must not interrupt editing. */ }
    finally {checking=false;}
  };
  const start=():void=>{if(timer===null)timer=setInterval(()=>void check(),60000);void check();};
  window.addEventListener('pagehide',()=>{if(timer!==null){clearInterval(timer);timer=null;}});
  window.addEventListener('pageshow',start);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void check();});
  start();
}
