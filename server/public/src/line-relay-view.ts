// 設定タブ「🏠 帰宅・出発 / LINE」 の「LINE 連携 (Concordia 経由)」 節。 spec/feature/line-relay.md。
// 中継トークンの発行 / 発行し直し / 消去 (平文は発行時に 1 度だけ表示) と、「つなぐ」 用 6 桁コードの発行。

import { scopedFetch } from './shared/scoped-fetch.js';

interface LineRelayStatusView { token_set: boolean; linked_talks: number }
interface IssuedLinkCode { code: string; expires_at: string }

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await scopedFetch(path, init);
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function postInit(method: string): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: '{}' };
}

function notice(text: string): void {
  const el = $('lrNotice');
  if (el) el.textContent = text;
}

function renderStatus(view: LineRelayStatusView): void {
  const el = $('lrStatus');
  if (el) el.textContent = `${view.token_set ? '中継トークン発行済み' : '中継トークン未発行 (LINE 連携は止まっています)'} / つながっているトーク ${view.linked_talks} 件`;
  ($('lrIssueTokenBtn') as HTMLButtonElement).textContent = view.token_set ? '中継トークンを発行し直す' : '中継トークンを発行';
  ($('lrClearTokenBtn') as HTMLButtonElement).disabled = !view.token_set;
}

function showOnce(id: string, text: string): void {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

async function issueToken(): Promise<void> {
  try {
    const r = await request<LineRelayStatusView & { token: string }>('/api/line/relay/token', postInit('POST'));
    renderStatus(r);
    showOnce('lrToken', r.token);
    notice('中継トークンを発行しました。いま表示している値を Concordia の LINE 設定 (Memoria) に入れてください。この画面を離れると二度と表示できません。');
  } catch (e) {
    notice(`中継トークンの発行に失敗しました: ${(e as Error).message}`);
  }
}

async function clearToken(): Promise<void> {
  try {
    renderStatus(await request<LineRelayStatusView>('/api/line/relay/token', { method: 'DELETE' }));
    showOnce('lrToken', '');
    notice('中継トークンを消しました。LINE 連携は止まります。');
  } catch (e) {
    notice(`中継トークンの消去に失敗しました: ${(e as Error).message}`);
  }
}

async function issueLinkCode(): Promise<void> {
  try {
    const r = await request<IssuedLinkCode>('/api/line/relay/link-code', postInit('POST'));
    const until = new Date(r.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    showOnce('lrLinkCode', `つなぐ ${r.code}`);
    notice(`つなぎたい LINE のトーク (1 対 1 / グループ) で「つなぐ ${r.code}」と送ってください。${until} まで、1 回だけ使えます。`);
  } catch (e) {
    notice(`コードの発行に失敗しました: ${(e as Error).message}`);
  }
}

/** 設定タブの本文を footer の前に差し込む (1 回だけ)。 */
export function mountLineRelaySettings(footer: Element): void {
  if ($('lineRelaySettingsBody')) return;
  const sec = document.createElement('section');
  sec.id = 'lineRelaySettingsBody';
  sec.className = 'settings-tab-body foundation-form hidden';
  sec.dataset.stab = 'home-presence';
  sec.innerHTML = `
    <h4 style="margin-top:16px">LINE 連携 (Concordia 経由)</h4>
    <p class="diary-settings-help">LINE の公式アカウントは Concordia が受け、Memoria 宛ての発言 (「タスク」「きょうのタスク」「にっき」など) だけを中継します。
      中継トークンを発行して Concordia に設定し、つなぎたいトークで「つなぐ 6 桁のコード」を送ってください。</p>
    <div id="lrStatus" class="muted" style="margin:6px 0"></div>
    <div style="margin-top:8px">
      <button id="lrIssueTokenBtn" type="button" class="primary">中継トークンを発行</button>
      <button id="lrClearTokenBtn" type="button">中継トークンを消す</button>
    </div>
    <pre id="lrToken" class="hidden" style="user-select:all;white-space:pre-wrap;word-break:break-all"></pre>
    <div style="margin-top:8px">
      <button id="lrLinkCodeBtn" type="button">「つなぐ」用のコードを出す</button>
    </div>
    <pre id="lrLinkCode" class="hidden" style="user-select:all"></pre>
    <p id="lrNotice" class="muted" style="margin-top:8px"></p>`;
  footer.parentNode?.insertBefore(sec, footer);
  ($('lrIssueTokenBtn') as HTMLButtonElement).onclick = () => { void issueToken(); };
  ($('lrClearTokenBtn') as HTMLButtonElement).onclick = () => { void clearToken(); };
  ($('lrLinkCodeBtn') as HTMLButtonElement).onclick = () => { void issueLinkCode(); };
}

/** タブを開いたときに読み込む。 */
export async function loadLineRelaySettings(): Promise<void> {
  try {
    renderStatus(await request<LineRelayStatusView>('/api/line/relay'));
  } catch (e) {
    notice(`LINE 連携の読み込みに失敗しました: ${(e as Error).message}`);
  }
}
