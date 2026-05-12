// 起動チュートリアル (6 step wizard)。
//
// 自動表示の判定は **localStorage** で per-device に管理する:
//   - サーバ側の `tutorial.completed_at` は全端末共有なので、 PC でクローズ
//     するとスマホで一度も表示されなくなる問題があった。 → localStorage
//     `memoria.tutorial.shown` を per-device に立てて、 端末ごとに「初回」
//     体験を出すようにする。
//   - 「完了」 / 「スキップ」 / × どれを押しても localStorage + サーバ両方
//     に completion を書く。
//   - 設定 → AI / モデル の「🎓 はじめての Memoria を表示」 で
//     localStorage を消してから再表示する (= 同じ端末で何度でも見直せる)。
//
// app.ts から initTutorial(deps) を 1 回呼ぶ。 共通関数 (api / switchTab /
// pushSubscribeFlow / refreshMultiStatus) は deps で受け取って、 このファイル
// 単体で動かす。 HTML 構造は index.html の #tutorialOverlay に依存。

const TOTAL_STEPS = 6;
const SHOWN_LS_KEY = 'memoria.tutorial.shown';

// Step 2 の AI 自動処理 opt-out チェックボックス。 設定 → AI / モデル の
// 「🚦 AI 自動処理」 と同じ feature flag を operate する。
const AUTO_FLAGS: { id: string; key: string }[] = [
  { id: 'tutAutoBookmarkSummarize', key: 'bookmarks_auto_summarize' },
  { id: 'tutAutoPageMetadata',      key: 'page_metadata_auto_fetch' },
  { id: 'tutAutoDomainClassify',    key: 'domain_catalog_auto_classify' },
  { id: 'tutAutoMealVision',        key: 'meals_auto_vision' },
  { id: 'tutAutoDiaryGenerate',     key: 'diary_auto_generate' },
];

export interface TutorialDeps {
  /** fetch wrapper (= app.ts の `api` 関数)。 JSON を直接返す。 */
  api: (path: string, opts?: RequestInit) => Promise<unknown>;
  /** タブ切替 (= app.ts の `switchTab(tab)`)。 */
  switchTab: (tab: string) => void;
  /** 通知サブスクライブ (= app.ts の pushSubscribeFlow)。 */
  pushSubscribeFlow: () => Promise<void>;
  /** Multi-server status をリフレッシュ。 Hub 登録後に呼ぶ。 */
  refreshMultiStatus: () => Promise<void>;
  /** ヘルプ drawer を開く (= help-drawer.ts の openHelpFor)。 */
  openHelpFor: (tab: string) => void;
  /** state 取得 (worklog / database のサブタブ状態を反映するため)。 */
  getState: () => { worklog?: { sub?: string }; database?: { sub?: string } };
  /** 設定パネルを閉じる (= 「🎓 再表示」 ボタンを押されたとき)。 */
  closeSettingsPanel: () => void;
}

interface TutorialApiResponse {
  ok?: boolean;
  completed?: boolean;
  apiKey?: string;
  picked?: string;
  project?: string;
  key?: string;
  reason?: string;
  error?: string;
  active?: boolean;
  configured?: boolean;
  last_seen?: string;
  server?: unknown;
}

const REASON_HINT: Record<string, string> = {
  not_installed: 'gcloud CLI が PATH に見つかりません',
  not_authenticated: '`gcloud auth login` で認証が必要です',
  no_project: '`gcloud config set project <ID>` で active project を設定してください',
  no_keys: 'project に Maps API key がありません',
  no_string: 'keyString の取得に失敗しました',
  exec_failed: 'gcloud 実行に失敗しました',
};

let deps: TutorialDeps | null = null;
let step = 1;
let extPollTimer: ReturnType<typeof setInterval> | null = null;

function $id<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function safeText(el: HTMLElement | null, text: string): void {
  if (el) el.textContent = text;
}

function call<T = TutorialApiResponse>(path: string, opts?: RequestInit): Promise<T> {
  return deps!.api(path, opts) as Promise<T>;
}

export function openTutorial(): void {
  const overlay = $id('tutorialOverlay');
  if (!overlay) return;
  overlay.hidden = false;
  gotoStep(1);
  if (!extPollTimer) {
    refreshExtensionStatus();
    extPollTimer = setInterval(refreshExtensionStatus, 5_000);
  }
  updatePushStatus();
  // Step 2 の AI 自動処理トグルは開くたびに最新値を反映する。
  loadAutoFlagsIntoUI().catch((e) => console.warn('autoflag load failed:', e));
}

export function closeTutorial(): void {
  const overlay = $id('tutorialOverlay');
  if (overlay) overlay.hidden = true;
  if (extPollTimer) {
    clearInterval(extPollTimer);
    extPollTimer = null;
  }
  // per-device に「もう出さない」 を記録 (= 同じ端末では auto-open しない)。
  try { localStorage.setItem(SHOWN_LS_KEY, '1'); } catch { /* iOS private mode 等 */ }
  // サーバ側にも completion を書いておく (起動時の「全端末で 1 度でも完了
  // したか」 を集計したいケース用のメタ情報、 自動表示判定では使わない)。
  call('/api/tutorial/complete', { method: 'POST' }).catch(() => { /* swallow */ });
}

function gotoStep(n: number): void {
  step = Math.max(1, Math.min(TOTAL_STEPS, n));
  document.querySelectorAll<HTMLElement>('.tutorial-step-body').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.step !== String(step));
  });
  document.querySelectorAll<HTMLElement>('.tutorial-stepper .tutorial-step').forEach((el) => {
    const idx = Number(el.dataset.step);
    el.classList.toggle('active', idx === step);
    el.classList.toggle('done', idx < step);
  });
  safeText($id('tutorialStepLabel'), String(step));
  const prev = $id<HTMLButtonElement>('tutorialPrev');
  const next = $id<HTMLButtonElement>('tutorialNext');
  if (prev) prev.hidden = step === 1;
  if (next) next.textContent = step === TOTAL_STEPS ? '完了' : '次へ →';
}

function updatePushStatus(): void {
  const el = $id('tutorialPushStatus');
  if (!el) return;
  if (!('Notification' in window)) { el.textContent = 'このブラウザは通知に未対応'; return; }
  const p = Notification.permission;
  el.textContent = p === 'granted' ? '✓ 許可済み'
    : p === 'denied' ? '✕ 拒否済み (ブラウザ設定から再許可してください)'
    : '未設定';
}

async function refreshExtensionStatus(): Promise<void> {
  const el = $id('tutorialExtStatus');
  if (!el) return;
  try {
    const s = await call<TutorialApiResponse>('/api/extension/status');
    if (s.active) {
      el.textContent = '✓ 拡張を検出しました (直近 5 分以内に通信あり)';
    } else if (s.configured) {
      el.textContent = `△ 24 時間以内に通信あり (last_seen: ${s.last_seen})`;
    } else {
      el.textContent = '⏳ 拡張からの通信を待っています';
    }
  } catch { /* swallow */ }
}

function wireNavigation(): void {
  $id('tutorialClose')?.addEventListener('click', closeTutorial);
  $id('tutorialSkip')?.addEventListener('click', closeTutorial);
  $id('tutorialPrev')?.addEventListener('click', () => gotoStep(step - 1));
  $id('tutorialNext')?.addEventListener('click', () => {
    if (step >= TOTAL_STEPS) closeTutorial();
    else gotoStep(step + 1);
  });
  document.querySelectorAll<HTMLElement>('.tutorial-stepper .tutorial-step').forEach((btn) => {
    btn.addEventListener('click', () => {
      const n = Number(btn.dataset.step);
      if (Number.isInteger(n)) gotoStep(n);
    });
  });
}

function wireStep1(): void {
  $id('tutorialPushBtn')?.addEventListener('click', async () => {
    try { await deps!.pushSubscribeFlow(); }
    catch (e) { console.warn('push subscribe failed:', e); }
    updatePushStatus();
  });
}

// ── Step 2: AI 自動処理 opt-out (= /api/privacy/settings の 5 flag) ──
interface PrivacySettingsBody {
  settings?: Record<string, boolean | number | string>;
}

async function loadAutoFlagsIntoUI(): Promise<void> {
  const r = await call<PrivacySettingsBody>('/api/privacy/settings');
  const s = r.settings || {};
  for (const f of AUTO_FLAGS) {
    const el = $id<HTMLInputElement>(f.id);
    if (el) el.checked = s[f.key] !== false;
  }
  const status = $id('tutorialAutoStatus');
  if (status) status.textContent = '';
}

async function patchAutoFlag(key: string, value: boolean): Promise<void> {
  const status = $id('tutorialAutoStatus');
  if (status) status.textContent = '保存中…';
  try {
    await call('/api/privacy/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    });
    if (status) status.textContent = '✓ 保存しました';
  } catch (e) {
    if (status) status.textContent = `⚠ 保存失敗: ${(e as Error).message}`;
  }
}

function wireStep2(): void {
  for (const f of AUTO_FLAGS) {
    const el = $id<HTMLInputElement>(f.id);
    if (!el) continue;
    el.addEventListener('change', () => {
      patchAutoFlag(f.key, el.checked).catch((e) => console.warn(`flag ${f.key}:`, e));
    });
  }
}

// ── Step 3: Chrome 拡張インストール手順 ──────────────────────────────
//
// `chrome://extensions` (および edge://, about:addons 等) は Web page から
// window.open / <a href> で navigate できない (ブラウザがセキュリティ目的で
// ブロック)。 そのため「拡張設定を開く」 ボタンは:
//   1. 拡張ページ URL を clipboard にコピー
//   2. 新しいタブを開く (= ユーザがアドレスバーに focus した状態を作る)
//   3. 「アドレスバーに貼って Enter」 を案内する
// の 3 つを同時にやる。 ブラウザは UA から判定して URL / ラベルを出し分け。

interface BrowserInfo {
  name: 'chrome' | 'edge' | 'brave' | 'opera' | 'firefox' | 'safari' | 'unknown';
  label: string;        // ボタン左の説明 (例: 「Chrome の拡張機能ページ」)
  url: string | null;   // 開く先 URL (null = 拡張未対応ブラウザ)
  buttonText: string;   // ボタン本体
  note?: string;        // 補足 (= 拡張が動かないブラウザ等)
}

function detectBrowser(): BrowserInfo {
  const ua = navigator.userAgent || '';
  if (/Edg\//.test(ua)) {
    return {
      name: 'edge',
      label: 'Edge の拡張機能ページ',
      url: 'edge://extensions',
      buttonText: '🧩 Edge の拡張設定を開く',
    };
  }
  if (/OPR\//.test(ua) || /Opera\//.test(ua)) {
    return {
      name: 'opera',
      label: 'Opera の拡張機能ページ',
      url: 'opera://extensions',
      buttonText: '🧩 Opera の拡張設定を開く',
    };
  }
  if (/Brave/i.test(ua) || (navigator as unknown as { brave?: unknown }).brave) {
    return {
      name: 'brave',
      label: 'Brave の拡張機能ページ',
      url: 'brave://extensions',
      buttonText: '🧩 Brave の拡張設定を開く',
    };
  }
  if (/Firefox\//.test(ua)) {
    return {
      name: 'firefox',
      label: 'Firefox のアドオン管理ページ',
      url: 'about:addons',
      buttonText: '🧩 Firefox のアドオン設定を開く',
      note: '⚠ Memoria 拡張は Chrome MV3 ベースのため、 Firefox では一部 API が動かない可能性があります。',
    };
  }
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) {
    return {
      name: 'safari',
      label: 'Safari は専用拡張が必要',
      url: null,
      buttonText: '— Safari は未対応 —',
      note: '⚠ Memoria 拡張は Safari に対応していません。 Memoria を「ホーム画面に追加」 して PWA として開き、 共有メニューから保存してください。',
    };
  }
  if (/Chrome\//.test(ua) || /Chromium\//.test(ua)) {
    return {
      name: 'chrome',
      label: 'Chrome の拡張機能ページ',
      url: 'chrome://extensions',
      buttonText: '🧩 Chrome の拡張設定を開く',
    };
  }
  return {
    name: 'unknown',
    label: 'お使いのブラウザは未対応',
    url: null,
    buttonText: '— ブラウザを判定できません —',
    note: '⚠ Memoria 拡張は Chromium 系 (Chrome / Edge / Brave / Opera) を想定しています。 Chrome での利用を推奨します。',
  };
}

async function openExtensionsPage(info: BrowserInfo, btn: HTMLButtonElement): Promise<void> {
  if (!info.url) return;
  const status = $id('tutorialExtStatus');
  // 1. URL を clipboard にコピー (失敗しても気にしない)
  try { await navigator.clipboard.writeText(info.url); } catch { /* iOS private 等 */ }
  // 2. 新しいタブを開く — chrome:// / about: は実際には navigate できないが、
  //    タブが開いた状態を作ることで「アドレスバーに貼ってください」 動作に
  //    つなげる。 popup blocker 対策で user activation 内で呼ぶ必要があるので
  //    このハンドラ自体が click イベント由来。
  let opened: Window | null = null;
  try { opened = window.open(info.url, '_blank'); } catch { /* swallow */ }
  // 3. UI フィードバック
  const original = btn.textContent || info.buttonText;
  btn.textContent = '✓ URL をコピー / タブを開きました';
  setTimeout(() => { btn.textContent = original; }, 4000);
  if (status) {
    status.textContent = (opened && !opened.closed)
      ? `新しいタブが開きました。 アドレスバーに ${info.url} を貼って Enter してください (クリップボードに既にコピー済み)`
      : `URL "${info.url}" をクリップボードにコピーしました。 新しいタブを開いてアドレスバーに貼って Enter してください`;
  }
}

interface ServerInfo {
  port?: number;
  extension_url?: string;
}

async function fillExtensionTargetUrl(): Promise<void> {
  // 拡張は PC 内の Memoria に loopback 接続するため、 window.location.origin
  // (= Tailscale / Tunnel 経由のホスト名かもしれない) は使わず、 サーバが
  // 教えてくれる localhost:<configured_port> を表示する。
  const el = $id('tutorialExtUrl');
  if (!el) return;
  try {
    const info = await call<ServerInfo>('/api/server/info');
    if (info?.extension_url) el.textContent = info.extension_url;
    else if (info?.port) el.textContent = `http://localhost:${info.port}`;
  } catch {
    // /api/server/info が無い (旧サーバ) 場合のフォールバック。
    el.textContent = 'http://localhost:5180';
  }
}

function wireStep3(): void {
  // 拡張から接続する先 URL = localhost:<configured_port> をサーバから取得
  fillExtensionTargetUrl().catch(() => { /* swallow */ });

  // ブラウザ判定 → 「拡張設定を開く」 ボタンの URL / ラベル / 補足を出し分け
  const info = detectBrowser();
  const btn = $id<HTMLButtonElement>('tutorialExtOpenBtn');
  const urlEl = $id('tutorialExtOpenUrl');
  const labelEl = $id('tutorialExtOpenLabel');
  const note = $id('tutorialExtBrowserNote');

  if (btn) {
    btn.textContent = info.buttonText;
    btn.disabled = !info.url;
    btn.addEventListener('click', () => { openExtensionsPage(info, btn).catch(() => { /* swallow */ }); });
  }
  if (urlEl) urlEl.textContent = info.url ?? '(未対応)';
  if (labelEl) labelEl.textContent = info.label;
  // 拡張未対応ブラウザ向けの補足を上書き (デフォルトのスマホ補足は Chrome 系では維持)
  if (note && info.note) note.textContent = info.note;
}

// ── Step 4: 共有サーバ (Memoria Hub) 登録 ────────────────────────────
function wireStep4(): void {
  $id('tutorialHubAddBtn')?.addEventListener('click', async () => {
    const input = $id<HTMLInputElement>('tutorialHubUrl');
    const status = $id('tutorialHubStatus');
    if (!input || !status) return;
    const url = (input.value || '').trim();
    if (!url) { status.textContent = 'URL を入力してください'; return; }
    status.textContent = '登録中…';
    try {
      const r = await call<TutorialApiResponse>('/api/multi/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      status.textContent = (r?.ok || r?.server)
        ? '✓ 登録しました (設定 → 📦 データ / Hub から認証してください)'
        : '⚠ 登録できませんでした';
      await deps!.refreshMultiStatus();
    } catch (e) {
      status.textContent = `⚠ ${(e as Error).message}`;
    }
  });
}

// ── Step 5: 追加 API (OwnTracks ingest key + Maps API key) ────────────
function wireStep5(): void {
  // OwnTracks ingest key (= 合言葉) の生成
  $id('tutorialIngestBtn')?.addEventListener('click', async () => {
    const status = $id('tutorialIngestStatus');
    const box = $id('tutorialIngestKeyBox');
    if (!status || !box) return;
    status.textContent = '生成中…';
    try {
      const r = await call<TutorialApiResponse>('/api/locations/settings/regenerate', { method: 'POST' });
      if (r?.key) {
        box.textContent = r.key;
        box.classList.remove('hidden');
        status.textContent = '✓ 生成しました。 表示された文字列を今すぐコピーしてください (このウィンドウを閉じると再表示できません)';
      } else {
        status.textContent = '⚠ 生成に失敗しました';
      }
    } catch (e) {
      status.textContent = `⚠ ${(e as Error).message}`;
    }
  });

  // Maps API key 自動取得
  $id('tutorialMapsAutoBtn')?.addEventListener('click', async () => {
    const status = $id('tutorialMapsStatus');
    if (!status) return;
    status.textContent = 'gcloud から取得中…';
    try {
      const r = await call<TutorialApiResponse>('/api/maps/config/auto-fetch', { method: 'POST' });
      if (r?.ok && r.apiKey) {
        status.textContent = `✓ ${r.picked || 'API key'} を取得・保存しました (project: ${r.project})`;
        const inp = $id<HTMLInputElement>('tutorialMapsKey');
        if (inp) inp.value = r.apiKey;
      } else {
        const reason = (r && typeof r.reason === 'string') ? r.reason : 'unknown';
        status.textContent = `⚠ ${REASON_HINT[reason] || reason}: ${r?.error || ''}`;
      }
    } catch (e) {
      status.textContent = `⚠ ${(e as Error).message}`;
    }
  });

  // Maps API key 手動保存
  $id('tutorialMapsSaveBtn')?.addEventListener('click', async () => {
    const inp = $id<HTMLInputElement>('tutorialMapsKey');
    const status = $id('tutorialMapsStatus');
    if (!inp || !status) return;
    const apiKey = (inp.value || '').trim();
    if (!apiKey) { status.textContent = 'API key を入力してください'; return; }
    try {
      await call('/api/maps/config', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      status.textContent = '✓ 保存しました';
    } catch (e) {
      status.textContent = `⚠ ${(e as Error).message}`;
    }
  });
}

// ── Step 6: 機能カードクリックで該当タブへジャンプ ─────────────────
function wireStep6(): void {
  document.querySelectorAll<HTMLButtonElement>('.tutorial-feature[data-go]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.go || 'database';
      const sub = btn.dataset.sub || '';
      closeTutorial();
      try { deps!.switchTab(tab); } catch { /* fallback */ }
      // サブタブ指定があれば worklog / database の中で更にスイッチ
      if (sub) {
        try {
          const state = deps!.getState();
          if (tab === 'worklog' && state.worklog) {
            state.worklog.sub = sub;
            document.querySelector<HTMLElement>(`#worklogSubtabs [data-sub="${sub}"]`)?.click();
          } else if (tab === 'database' && state.database) {
            state.database.sub = sub;
            document.querySelector<HTMLElement>(`#databaseSubtabs [data-sub="${sub}"]`)?.click();
          }
        } catch { /* swallow */ }
      }
      // ヘルプ drawer を続けて開く (そのページの説明をそのまま読める)
      setTimeout(() => deps!.openHelpFor(tab), 200);
    });
  });
}

function wireReopenButton(): void {
  // 設定 → AI / モデル の「🎓 はじめての Memoria を表示」 ボタン
  $id('tutorialReopenBtn')?.addEventListener('click', async () => {
    const status = $id('tutorialReopenStatus');
    // localStorage を消すと「この端末は未表示」 扱いになる。
    try { localStorage.removeItem(SHOWN_LS_KEY); } catch { /* iOS private */ }
    try { await call('/api/tutorial/reset', { method: 'POST' }); } catch { /* swallow */ }
    deps!.closeSettingsPanel();
    openTutorial();
    if (status) status.textContent = '';
  });
}

function autoOpenIfFirstLaunch(): void {
  // 端末ごとに 1 度だけ自動表示。 サーバ side completion は参照しない
  // (= 別端末でクローズしたとしてもこの端末では出る)。
  let shown: string | null = null;
  try { shown = localStorage.getItem(SHOWN_LS_KEY); } catch { /* private mode 等 */ }
  if (!shown) openTutorial();
}

export function initTutorial(d: TutorialDeps): void {
  deps = d;
  wireNavigation();
  wireStep1();
  wireStep2();
  wireStep3();
  wireStep4();
  wireStep5();
  wireStep6();
  wireReopenButton();
  autoOpenIfFirstLaunch();
}
