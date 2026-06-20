// 🤖 AI タブ — AI記事 / AIアドバイス と 📝 ログ配下の「記事ネタ」 のフロントエンド。
//
// app.ts (巨大 God file) からは loadAiArticlesView() / loadAiAdviceView() /
// loadAiSeedsView() を呼ぶだけ。 各々が自前で対象 root に fetch + 描画する
// 自己完結モジュール (app.ts の state / DOM 内部には依存しない)。
//
// spec: spec/feature/ai-hub.md (API 契約・UI 構成の正本)。
// Markdown 描画は app.ts と共通の markdown-block.ts を流用する。

import { renderMarkdownBlock } from './markdown-block.js';

// ── API 型 (server/ai-hub/types.ts に対応) ───────────────────────────────────

interface AiArticle {
  id: number;
  title: string;
  body_md: string;
  topic_key: string | null;
  source_refs: string | null;
  origin: string;
  for_date: string | null;
  note_id: number | null;
  created_at: string;
}

interface AiSeed {
  id: number;
  title: string;
  summary: string | null;
  angle: string | null;
  source_refs: string | null;
  for_date: string | null;
  status: string;
  article_id: number | null;
  created_at: string;
}

interface AiAdvice {
  id: number;
  for_date: string;
  body_md: string;
  data_summary: string | null;
  created_at: string;
}

interface SourceRef {
  kind?: string;
  ref?: string;
  repo?: string;
}

// ── 小物 ─────────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}

async function sendJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${res.status} ${t.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function relDate(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return esc(iso);
  return new Date(t).toLocaleDateString('ja-JP');
}

/** source_refs (JSON 配列文字列) を読み出し用バッジ列に。 失敗時は空文字。 */
function sourceRefsBadges(json: string | null): string {
  if (!json) return '';
  let refs: SourceRef[];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return '';
    refs = parsed as SourceRef[];
  } catch {
    return '';
  }
  if (!refs.length) return '';
  const badges = refs.slice(0, 8).map((r) => {
    const label = [r.repo, r.kind, r.ref].filter(Boolean).join(' · ');
    return `<span class="ai-src-badge">${esc(label || 'source')}</span>`;
  }).join('');
  return `<div class="ai-src-badges">${badges}</div>`;
}

let toastFn: (msg: string) => void = (msg) => { console.log(msg); };

/** app.ts のトースト関数を注入してもらう (importInit から)。 */
export function setAiToast(fn: (msg: string) => void): void {
  if (typeof fn === 'function') toastFn = fn;
}

function toast(msg: string): void {
  try { toastFn(msg); } catch { /* noop */ }
}

// ── 📰 AI記事 ────────────────────────────────────────────────────────────────

function articleCard(a: AiArticle): string {
  const transcribed = a.note_id != null;
  const meta = [
    a.origin === 'requested' ? '📝 依頼' : '🌅 ダイジェスト',
    a.for_date ? `対象 ${esc(a.for_date)}` : '',
    a.created_at ? `${relDate(a.created_at)} 生成` : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="ai-article-card" data-article="${a.id}">
      <div class="ai-article-head">
        <strong class="ai-article-title">${esc(a.title)}</strong>
      </div>
      <div class="ai-article-meta muted">${meta}</div>
      ${sourceRefsBadges(a.source_refs)}
      <div class="ai-article-body hidden" data-article-body="${a.id}"></div>
      <div class="ai-article-actions">
        <button class="ghost" data-article-toggle="${a.id}">📖 表示</button>
        <button class="ghost" data-article-transcribe="${a.id}" ${transcribed ? 'disabled' : ''}>
          ${transcribed ? '📓 転写済み' : '📓 ノートへ転写'}
        </button>
      </div>
    </div>`;
}

function bindArticleActions(container: HTMLElement, articles: AiArticle[]): void {
  const byId = new Map(articles.map((a) => [a.id, a]));
  container.querySelectorAll<HTMLButtonElement>('[data-article-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.articleToggle);
      const bodyEl = container.querySelector<HTMLElement>(`[data-article-body="${id}"]`);
      const a = byId.get(id);
      if (!bodyEl || !a) return;
      const showing = !bodyEl.classList.contains('hidden');
      if (showing) {
        bodyEl.classList.add('hidden');
        btn.textContent = '📖 表示';
      } else {
        if (!bodyEl.dataset.rendered) {
          bodyEl.innerHTML = renderMarkdownBlock(a.body_md);
          bodyEl.dataset.rendered = '1';
        }
        bodyEl.classList.remove('hidden');
        btn.textContent = '📖 隠す';
      }
    });
  });
  container.querySelectorAll<HTMLButtonElement>('[data-article-transcribe]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.articleTranscribe);
      btn.disabled = true;
      btn.textContent = '転写中…';
      try {
        await sendJson<{ note: { id: number } }>(`/api/ai/articles/${id}/transcribe`, 'POST', {});
        btn.textContent = '📓 転写済み';
        toast('ノートに転写しました');
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '📓 ノートへ転写';
        toast(`転写に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  });
}

/** app.ts の switchTab('ai') → サブ 'articles' から呼ばれる。 */
export async function loadAiArticlesView(): Promise<void> {
  const root = document.getElementById('aiArticlesRoot');
  if (!root) return;
  root.innerHTML = '<div class="muted">読み込み中…</div>';
  try {
    const { articles } = await getJson<{ articles: AiArticle[] }>('/api/ai/articles?limit=50');
    if (!articles.length) {
      root.innerHTML = `<div class="empty">まだ AI 記事がありません。毎朝 6:00 に前日の作業から自動生成されます。「記事ネタ」 から記事化を依頼することもできます。</div>`;
      return;
    }
    root.innerHTML = `<div class="ai-article-list">${articles.map(articleCard).join('')}</div>`;
    bindArticleActions(root, articles);
  } catch (e) {
    root.innerHTML = `<div class="empty">読み込みに失敗しました: ${esc(e instanceof Error ? e.message : String(e))}</div>`;
  }
}

// ── 💡 AIアドバイス ──────────────────────────────────────────────────────────

/** app.ts の switchTab('ai') → サブ 'advice' から呼ばれる。 */
export async function loadAiAdviceView(): Promise<void> {
  const root = document.getElementById('aiAdviceRoot');
  if (!root) return;
  root.innerHTML = '<div class="muted">読み込み中…</div>';
  let advice: AiAdvice | null = null;
  try {
    const r = await getJson<{ advice: AiAdvice | null }>('/api/ai/advice/latest');
    advice = r.advice;
  } catch {
    advice = null;
  }
  const header = `
    <div class="ai-advice-head">
      <h3 style="margin:0">💡 AIアドバイス</h3>
      ${advice ? `<span class="muted">${esc(advice.for_date)}</span>` : ''}
      <span class="grow"></span>
      <button id="aiAdviceRunNow" class="primary">${advice ? '↻ 今すぐ生成' : '✨ 今すぐ生成'}</button>
    </div>`;
  root.innerHTML = header + (advice
    ? `<div class="ai-advice-body">${renderMarkdownBlock(advice.body_md)}</div>`
    : `<div class="empty">まだ助言がありません。直近 1 週間の日記・ニュース・傾向・おすすめ・タスクから、AI が「次にこうしたら」 という助言を出します。上のボタンで今すぐ生成できます。</div>`);

  root.querySelector('#aiAdviceRunNow')?.addEventListener('click', async () => {
    const btn = root.querySelector('#aiAdviceRunNow') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    try {
      await sendJson<{ advice: AiAdvice }>('/api/ai/advice/run-now', 'POST', {});
      toast('AIアドバイスを生成しました');
      await loadAiAdviceView();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '✨ 再試行'; }
      toast(`生成できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

// ── 📝 記事ネタ (📝 ログタブ配下) ─────────────────────────────────────────────

function seedRow(s: AiSeed): string {
  return `
    <div class="ai-seed-row" data-seed="${s.id}">
      <div class="ai-seed-main">
        <div class="ai-seed-title"><strong>${esc(s.title)}</strong></div>
        ${s.angle ? `<div class="ai-seed-angle muted">アングル: ${esc(s.angle)}</div>` : ''}
        ${s.summary ? `<div class="ai-seed-summary muted">${esc(s.summary)}</div>` : ''}
        ${sourceRefsBadges(s.source_refs)}
        <div class="ai-seed-meta muted">${s.for_date ? `対象 ${esc(s.for_date)} · ` : ''}${relDate(s.created_at)}</div>
      </div>
      <div class="ai-seed-actions">
        <button class="primary" data-seed-request="${s.id}">記事化を依頼する</button>
        <button class="ghost" data-seed-dismiss="${s.id}">却下</button>
      </div>
    </div>`;
}

/** app.ts の worklog サブ 'seeds' から呼ばれる。 */
export async function loadAiSeedsView(): Promise<void> {
  const root = document.getElementById('aiSeedsRoot');
  if (!root) return;
  root.innerHTML = '<div class="muted">読み込み中…</div>';
  try {
    const { seeds } = await getJson<{ seeds: AiSeed[] }>('/api/ai/seeds?status=pending');
    if (!seeds.length) {
      root.innerHTML = `<div class="empty">記事ネタはまだありません。毎朝 6:00 のダイジェストで、記事化できそうなネタが溜まります。</div>`;
      return;
    }
    root.innerHTML = `<div class="ai-seed-list">${seeds.map(seedRow).join('')}</div>`;
    bindSeedActions(root);
  } catch (e) {
    root.innerHTML = `<div class="empty">読み込みに失敗しました: ${esc(e instanceof Error ? e.message : String(e))}</div>`;
  }
}

function bindSeedActions(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>('[data-seed-request]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.seedRequest);
      btn.disabled = true;
      btn.textContent = '記事化中…';
      try {
        await sendJson<{ article: AiArticle }>(`/api/ai/seeds/${id}/request`, 'POST', {});
        toast('記事化しました。🤖 AI タブの「AI記事」 に追加されました。');
        container.querySelector(`[data-seed="${id}"]`)?.remove();
        await loadAiArticlesView().catch(() => { /* AI タブ未表示なら無視 */ });
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '記事化を依頼する';
        toast(`記事化に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  });
  container.querySelectorAll<HTMLButtonElement>('[data-seed-dismiss]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.seedDismiss);
      btn.disabled = true;
      try {
        await sendJson<{ ok: true }>(`/api/ai/seeds/${id}/dismiss`, 'POST', {});
        container.querySelector(`[data-seed="${id}"]`)?.remove();
      } catch (e) {
        btn.disabled = false;
        toast(`却下に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  });
}
