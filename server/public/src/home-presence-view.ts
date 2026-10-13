// 設定タブ「🏠 帰宅・出発 / LINE」。 spec/feature/home-presence-notify.md。
// 帰宅・出発通知の判定設定と rule、 LINE の送信設定を編集する。

import { scopedFetch } from './shared/scoped-fetch.js';

type PresenceEvent = 'approach' | 'arrive' | 'depart';
type Destination = { kind: 'discord'; channel: string } | { kind: 'line' };

interface PresenceConfig {
  enabled: boolean;
  nearRadiusM: number;
  hysteresisM: number;
  staleMin: number;
  cooldownMin: number;
}

interface PresenceRule {
  id: string;
  name: string;
  enabled: boolean;
  event: PresenceEvent;
  message: string;
  includeTasks: boolean;
  filter: { categories: string[]; deadline: 'all' | 'due_today_or_overdue' };
  sendWhenEmpty: boolean;
  destinations: Destination[];
}

interface PresenceStatus {
  home: { source: 'work_location' | 'weather'; name: string; radiusM: number } | null;
  zone: 'home' | 'near' | 'away' | null;
  gpsAgeMin: number | null;
}

interface PresenceResponse {
  config: PresenceConfig;
  rules: PresenceRule[];
  status: PresenceStatus;
  choices: { categories: string[]; channels: string[]; defaultMessages: Record<PresenceEvent, string> };
}

interface LineSettingsView { token_set: boolean; to: string }

const EVENT_LABELS: Record<PresenceEvent, string> = {
  approach: '近くに来た',
  arrive: '家に着いた',
  depart: '家を出発した',
};
const ZONE_LABELS = { home: '自宅', near: '近く', away: '外' } as const;

let rules: PresenceRule[] = [];
let channels: string[] = ['announce'];
let defaultMessages: Record<PresenceEvent, string> = { approach: '', arrive: '', depart: '' };

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await scopedFetch(path, init);
  const body = await response.json().catch(() => ({})) as { error?: string; reason?: string } & T;
  if (!response.ok) throw new Error(body.reason || body.error || `HTTP ${response.status}`);
  return body;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function inputValue(scope: ParentNode, selector: string): string {
  return (scope.querySelector(selector) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
}

function checked(scope: ParentNode, selector: string): boolean {
  return (scope.querySelector(selector) as HTMLInputElement | null)?.checked ?? false;
}

function notice(text: string): void {
  const el = $('hpNotice');
  if (el) el.textContent = text;
}

/** 設定タブの本文を footer の前に差し込む (1 回だけ)。 */
export function mountHomePresenceSettings(footer: Element): void {
  if ($('homePresenceSettingsBody')) return;
  const sec = document.createElement('section');
  sec.id = 'homePresenceSettingsBody';
  sec.className = 'settings-tab-body foundation-form hidden';
  sec.dataset.stab = 'home-presence';
  sec.innerHTML = `
    <h4>🏠 帰宅・出発通知</h4>
    <p class="diary-settings-help">家の近くに来た / 家に着いた / 家を出発した をきっかけに、一言と条件に合うタスク (例: 買い物) を Discord や LINE へ送ります。
      自宅は「作業場所」で自宅に指定した場所、無ければ天気の固定座標を使います。</p>
    <div id="hpStatus" class="muted" style="margin:6px 0"></div>
    <label class="check-inline"><input id="hpEnabled" type="checkbox" /> 帰宅・出発の判定を有効にする</label>
    <label style="display:flex;align-items:center;gap:6px">「近く」の半径
      <input id="hpNearRadius" type="number" min="300" max="5000" step="50" style="width:90px" /> m</label>
    <label style="display:flex;align-items:center;gap:6px">境界の余裕
      <input id="hpHysteresis" type="number" min="0" max="300" step="10" style="width:90px" /> m</label>
    <label style="display:flex;align-items:center;gap:6px">これより古い位置では判定しない
      <input id="hpStale" type="number" min="1" max="120" style="width:90px" /> 分</label>
    <label style="display:flex;align-items:center;gap:6px">同じ通知を再び出すまで
      <input id="hpCooldown" type="number" min="0" max="180" style="width:90px" /> 分</label>
    <h4 style="margin-top:12px">通知ルール</h4>
    <div id="hpRules"></div>
    <div style="margin-top:8px">
      <button id="hpAddRuleBtn" type="button">＋ ルールを追加</button>
      <button id="hpSaveBtn" type="button" class="primary">保存</button>
    </div>
    <h4 style="margin-top:16px">LINE</h4>
    <p class="diary-settings-help">LINE Developers で Messaging API チャネルを作り、チャネルアクセストークン (長期) と送り先 ID を入れてください。
      自分あての送り先 ID はチャネル基本設定の「あなたのユーザー ID」(U で始まる 33 文字) です。通知の本文は LINE に送られます。</p>
    <div id="lineStatus" class="muted" style="margin:6px 0"></div>
    <label>チャネルアクセストークン: <input id="lineToken" type="password" autocomplete="off" placeholder="変更するときだけ入力" /></label>
    <label>送り先 ID: <input id="lineTo" type="text" placeholder="U0123456789abcdef0123456789abcdef" /></label>
    <div style="margin-top:8px">
      <button id="lineSaveBtn" type="button" class="primary">LINE 設定を保存</button>
      <button id="lineTestBtn" type="button">LINE にテスト送信</button>
      <button id="lineClearBtn" type="button">トークンを消す</button>
    </div>
    <p id="hpNotice" class="muted" style="margin-top:8px"></p>`;
  footer.parentNode?.insertBefore(sec, footer);
  ($('hpAddRuleBtn') as HTMLButtonElement).onclick = addRule;
  ($('hpSaveBtn') as HTMLButtonElement).onclick = () => { void savePresence(); };
  ($('lineSaveBtn') as HTMLButtonElement).onclick = () => { void saveLine(false); };
  ($('lineClearBtn') as HTMLButtonElement).onclick = () => { void saveLine(true); };
  ($('lineTestBtn') as HTMLButtonElement).onclick = () => { void testLine(); };
}

function renderStatus(status: PresenceStatus): void {
  const el = $('hpStatus');
  if (!el) return;
  if (!status.home) {
    el.textContent = '自宅が未設定です。作業場所で自宅を指定するか、天気の固定座標を設定してください。';
    return;
  }
  const from = status.home.source === 'work_location' ? `作業場所「${status.home.name}」` : '天気の固定座標';
  const zone = status.zone ? ZONE_LABELS[status.zone] : '未判定';
  const gps = status.gpsAgeMin === null ? '位置情報なし' : `最新の位置は ${status.gpsAgeMin} 分前`;
  el.textContent = `自宅: ${from} (半径 ${status.home.radiusM}m) / いま: ${zone} / ${gps}`;
}

function renderConfig(config: PresenceConfig): void {
  ($('hpEnabled') as HTMLInputElement).checked = config.enabled;
  ($('hpNearRadius') as HTMLInputElement).value = String(config.nearRadiusM);
  ($('hpHysteresis') as HTMLInputElement).value = String(config.hysteresisM);
  ($('hpStale') as HTMLInputElement).value = String(config.staleMin);
  ($('hpCooldown') as HTMLInputElement).value = String(config.cooldownMin);
}

function collectConfig(): PresenceConfig {
  return {
    enabled: ($('hpEnabled') as HTMLInputElement).checked,
    nearRadiusM: Number(($('hpNearRadius') as HTMLInputElement).value),
    hysteresisM: Number(($('hpHysteresis') as HTMLInputElement).value),
    staleMin: Number(($('hpStale') as HTMLInputElement).value),
    cooldownMin: Number(($('hpCooldown') as HTMLInputElement).value),
  };
}

function ruleCard(rule: PresenceRule, i: number): string {
  const discord = rule.destinations.find((d) => d.kind === 'discord') as { kind: 'discord'; channel: string } | undefined;
  const line = rule.destinations.some((d) => d.kind === 'line');
  const eventOpts = (Object.keys(EVENT_LABELS) as PresenceEvent[])
    .map((ev) => `<option value="${ev}"${ev === rule.event ? ' selected' : ''}>${EVENT_LABELS[ev]}</option>`).join('');
  const chOpts = channels
    .map((c) => `<option value="${escapeHtml(c)}"${c === (discord?.channel ?? 'announce') ? ' selected' : ''}>#${escapeHtml(c)}</option>`).join('');
  return `
    <div class="hp-rule" data-i="${i}" style="border:1px solid #8884;border-radius:10px;padding:10px;margin-bottom:8px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <label class="check-inline"><input class="r-en" type="checkbox"${rule.enabled ? ' checked' : ''} /> 有効</label>
        <input class="r-name" type="text" value="${escapeHtml(rule.name)}" placeholder="名前 (例: 出発したら買い物)" style="flex:1;min-width:140px" />
        <select class="r-event">${eventOpts}</select>
        <button class="r-test" type="button">テスト送信</button>
        <button class="r-del" type="button">削除</button>
      </div>
      <div style="margin-top:6px">
        <input class="r-msg" type="text" value="${escapeHtml(rule.message)}" placeholder="${escapeHtml(defaultMessages[rule.event] || '一言')}" style="width:100%" />
      </div>
      <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <label class="check-inline"><input class="r-tasks" type="checkbox"${rule.includeTasks ? ' checked' : ''} /> タスクを添える</label>
        <span>カテゴリ</span><input class="r-cats" type="text" value="${escapeHtml(rule.filter.categories.join(','))}" placeholder="all または 買い物" style="min-width:140px" />
        <span>期限</span><select class="r-deadline">
          <option value="all"${rule.filter.deadline === 'all' ? ' selected' : ''}>全て</option>
          <option value="due_today_or_overdue"${rule.filter.deadline !== 'all' ? ' selected' : ''}>今日締切/超過のみ</option>
        </select>
        <label class="check-inline"><input class="r-empty" type="checkbox"${rule.sendWhenEmpty ? ' checked' : ''} /> 該当なしでも送る</label>
      </div>
      <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span>送り先</span>
        <label class="check-inline"><input class="r-discord" type="checkbox"${discord ? ' checked' : ''} /> Discord</label>
        <select class="r-channel">${chOpts}</select>
        <label class="check-inline"><input class="r-line" type="checkbox"${line ? ' checked' : ''} /> LINE</label>
      </div>
    </div>`;
}

function renderRules(): void {
  const box = $('hpRules');
  if (!box) return;
  if (!rules.length) {
    box.innerHTML = '<p class="muted">ルールはまだありません。「＋ ルールを追加」で作成します。</p>';
    return;
  }
  box.innerHTML = rules.map(ruleCard).join('');
  box.querySelectorAll('.hp-rule').forEach((el) => {
    const i = Number((el as HTMLElement).dataset.i);
    (el.querySelector('.r-event') as HTMLSelectElement).addEventListener('change', () => {
      rules = collectRules();
      renderRules();
    });
    (el.querySelector('.r-del') as HTMLButtonElement).addEventListener('click', () => {
      rules = collectRules();
      rules.splice(i, 1);
      renderRules();
    });
    (el.querySelector('.r-test') as HTMLButtonElement).addEventListener('click', () => { void testRule(i); });
  });
}

function collectRules(): PresenceRule[] {
  const box = $('hpRules');
  if (!box) return rules;
  const out: PresenceRule[] = [];
  box.querySelectorAll('.hp-rule').forEach((el, idx) => {
    const cats = inputValue(el, '.r-cats').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    const destinations: Destination[] = [];
    if (checked(el, '.r-discord')) destinations.push({ kind: 'discord', channel: inputValue(el, '.r-channel') || 'announce' });
    if (checked(el, '.r-line')) destinations.push({ kind: 'line' });
    const ev = inputValue(el, '.r-event') as PresenceEvent;
    out.push({
      id: rules[idx]?.id || '',
      name: inputValue(el, '.r-name'),
      enabled: checked(el, '.r-en'),
      event: ev in EVENT_LABELS ? ev : 'depart',
      message: inputValue(el, '.r-msg'),
      includeTasks: checked(el, '.r-tasks'),
      filter: {
        categories: cats.length ? cats : ['all'],
        deadline: inputValue(el, '.r-deadline') === 'due_today_or_overdue' ? 'due_today_or_overdue' : 'all',
      },
      sendWhenEmpty: checked(el, '.r-empty'),
      destinations,
    });
  });
  return out;
}

function addRule(): void {
  rules = collectRules();
  rules.push({
    id: '', name: '出発したら買い物', enabled: true, event: 'depart', message: '',
    includeTasks: true, filter: { categories: ['買い物'], deadline: 'all' },
    sendWhenEmpty: false, destinations: [{ kind: 'line' }],
  });
  renderRules();
}

async function savePresence(): Promise<boolean> {
  try {
    const r = await request<{ rules: PresenceRule[]; config: PresenceConfig }>(
      '/api/home-presence', jsonInit('PUT', { config: collectConfig(), rules: collectRules() }));
    rules = r.rules;
    renderConfig(r.config);
    renderRules();
    notice('帰宅・出発通知を保存しました');
    return true;
  } catch (e) {
    notice(`保存に失敗しました: ${(e as Error).message}`);
    return false;
  }
}

async function testRule(i: number): Promise<void> {
  // id を確定させるため保存してから送る
  if (!await savePresence()) return;
  const id = rules[i]?.id;
  if (!id) return;
  try {
    const r = await request<{ count: number; results: { kind: string; ok: boolean }[] }>(
      `/api/home-presence/rules/${encodeURIComponent(id)}/test`, jsonInit('POST', {}));
    const sent = r.results.filter((x) => x.ok).map((x) => x.kind).join(' / ');
    notice(`テスト送信しました (${sent}、タスク ${r.count} 件)`);
  } catch (e) {
    notice(`テスト送信に失敗しました: ${(e as Error).message}`);
  }
}

function renderLine(view: LineSettingsView): void {
  const el = $('lineStatus');
  if (el) el.textContent = view.token_set ? `トークン設定済み / 送り先 ${view.to || '未設定'}` : 'トークン未設定';
  ($('lineTo') as HTMLInputElement).value = view.to;
  ($('lineToken') as HTMLInputElement).value = '';
}

async function saveLine(clearToken: boolean): Promise<void> {
  const body = clearToken
    ? { clearToken: true }
    : { token: ($('lineToken') as HTMLInputElement).value, to: ($('lineTo') as HTMLInputElement).value };
  try {
    renderLine(await request<LineSettingsView>('/api/line/settings', jsonInit('PUT', body)));
    notice(clearToken ? 'LINE のトークンを消しました' : 'LINE 設定を保存しました');
  } catch (e) {
    notice(`LINE 設定の保存に失敗しました: ${(e as Error).message}`);
  }
}

async function testLine(): Promise<void> {
  try {
    await request('/api/line/test', jsonInit('POST', {}));
    notice('LINE にテスト送信しました');
  } catch (e) {
    notice(`LINE へのテスト送信に失敗しました: ${(e as Error).message}`);
  }
}

/** タブを開いたときに読み込む。 */
export async function loadHomePresenceSettings(): Promise<void> {
  try {
    const r = await request<PresenceResponse>('/api/home-presence');
    rules = r.rules;
    channels = r.choices.channels.length ? r.choices.channels : channels;
    defaultMessages = r.choices.defaultMessages;
    renderConfig(r.config);
    renderStatus(r.status);
    renderRules();
    renderLine(await request<LineSettingsView>('/api/line/settings'));
  } catch (e) {
    notice(`読み込みに失敗しました: ${(e as Error).message}`);
  }
}
