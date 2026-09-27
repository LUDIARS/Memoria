/**
 * Memoria Service Worker — PWA + WebPush + 最新画面取得 (個人データはキャッシュしない)。
 *
 * iOS Safari は PWA install (homescreen 追加) 後でないと PushManager.subscribe
 * が動かない仕様 (16.4+)。 manifest.webmanifest は既に index.html から
 * 読まれているので、 ここでは push event と notificationclick だけ扱う。
 *
 * push event の payload は server/push.js が JSON で送る:
 *   { title, body, url?, icon?, tag? }
 */

self.addEventListener('install', (event) => {
  // 即時 active 化 — 古い SW を待たずに新しいバージョンが効く
  self.skipWaiting();
});

// Lw と同じく画面更新は HTTP キャッシュを経由せず取得する。
// Memoria は個人データを扱うため、オフライン用のレスポンス保存は行わない。
self.addEventListener('fetch', (event) => {
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET' || url.origin!==self.location.origin)return;
  const api=url.pathname.startsWith('/api/') || url.pathname.startsWith('/tabula/api/');
  const frontend=['document','script','style','worker','manifest'].includes(request.destination)
    || url.pathname==='/app-version.json';
  if(!api && !frontend)return;
  event.respondWith(fetch(request,{cache:'no-store'}).catch(()=>new Response(
    api?JSON.stringify({error:'offline'}):'接続できません。通信状態を確認して再読み込みしてください。',
    {status:503,headers:{'Content-Type':api?'application/json':'text/plain; charset=utf-8','Cache-Control':'no-store'}},
  )));
});

self.addEventListener('activate', (event) => {
  // 既存タブにも最新取得方針を適用する。入力中の画面自体は自動再読込しない。
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Memoria', body: event.data.text() };
  }
  const title = payload.title || 'Memoria';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon-192.svg',
    badge: '/icon-192.svg',
    tag: payload.tag || 'memoria',
    data: { url: payload.url || '/' },
    // iOS は requireInteraction を無視するが、 Android Chrome の通知センター
    // 残留に効く
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification?.data?.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // 既に Memoria のタブが開いていればそれを focus + navigate
      for (const w of wins) {
        if (w.url && new URL(w.url).origin === self.location.origin) {
          return w.focus().then(() => {
            try { w.navigate(targetUrl); } catch { /* old browsers */ }
          });
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
