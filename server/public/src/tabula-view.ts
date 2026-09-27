import { appendTabulaFeed } from './tabula-feed.js';

let loading: Promise<void> | null = null;

/** Mount once: switching Memoria tabs must not discard Tabula's unsaved editor state. */
export function loadTabula(): Promise<void> {
  if (loading) return loading;
  const frame = document.getElementById('tabulaEditor') as HTMLIFrameElement | null;
  if (frame?.getAttribute('src')) return Promise.resolve();
  loading = connectTabula().finally(() => { loading = null; });
  return loading;
}

async function connectTabula(): Promise<void> {
  const status = document.getElementById('tabulaStatus');
  const link = document.getElementById('tabulaOpen') as HTMLAnchorElement | null;
  const frame = document.getElementById('tabulaEditor') as HTMLIFrameElement | null;
  const retry = document.getElementById('tabulaRetry') as HTMLButtonElement | null;
  if (!status || !link || !frame || !retry) return;
  retry.onclick = () => { void loadTabula(); };
  retry.hidden = true;
  link.hidden = true;
  status.textContent = 'Tabula に接続しています…';
  try {
    const response = await fetch('/api/tabula', { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const body = await response.json() as { url?: string; mode?: string; error?: string };
    if (!response.ok || !body.url) throw new Error(body.error ?? 'Tabula の接続先を取得できません');
    const url = new URL(body.url, location.href);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Tabula の URL が不正です');
    if (body.mode !== 'local') {
      link.href = url.href;
      link.hidden = false;
      status.textContent = '共有ワークスペースは別タブで開きます。';
      if (status.parentElement) void appendTabulaFeed(status.parentElement);
      return;
    }
    if (url.origin !== location.origin || url.pathname !== '/tabula/') {
      throw new Error('ローカル Tabula の表示先が不正です');
    }
    const session = await fetch('/tabula/api/session?workspace=local', {
      cache: 'no-store', signal: AbortSignal.timeout(20000),
    });
    if (!session.ok) throw new Error(`Tabula に接続できません (${session.status})`);
    const info = await session.json() as { mode?: string };
    if (info.mode !== 'local') throw new Error('Tabula のローカルモードを確認できません');
    // Same-origin proxy owns the access policy. The editor remains owned by Tabula.
    frame.src = url.href;
    frame.hidden = false;
    link.href = url.href;
    link.hidden = false;
    status.textContent = 'この端末のメモをここで作成・編集できます。';
  } catch (error) {
    frame.hidden = true;
    retry.hidden = false;
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}
