// ページごとのヘルプ drawer。
// 右上「💡 ヘルプ」 ボタンから現在のタブに合わせて開く。 中身は page-help.ts
// の PAGE_HELP 辞書から引く。 app.ts からは initHelpDrawer() を 1 回呼べば
// close ボタンが配線され、 openHelpFor(tab) で任意のタブのヘルプを表示できる。

import { PAGE_HELP } from './page-help.js';

const DRAWER_ID = 'helpDrawer';
const TITLE_ID = 'helpDrawerTitle';
const BODY_ID = 'helpDrawerBody';
const CLOSE_ID = 'helpDrawerClose';

export function openHelpFor(tab: string | null | undefined): void {
  const drawer = document.getElementById(DRAWER_ID);
  const titleEl = document.getElementById(TITLE_ID);
  const bodyEl = document.getElementById(BODY_ID);
  if (!drawer || !titleEl || !bodyEl) return;
  const help = (tab && PAGE_HELP[tab]) || {
    title: 'ヘルプ',
    bodyHtml: `<p>このページの解説はまだ用意されていません。 設定 → AI / モデルの <b>🎓 はじめての Memoria</b> も参照してください。</p>`,
  };
  titleEl.textContent = help.title;
  bodyEl.innerHTML = help.bodyHtml;
  drawer.hidden = false;
}

export function closeHelpDrawer(): void {
  const drawer = document.getElementById(DRAWER_ID);
  if (drawer) drawer.hidden = true;
}

export function initHelpDrawer(): void {
  document.getElementById(CLOSE_ID)?.addEventListener('click', closeHelpDrawer);
}
