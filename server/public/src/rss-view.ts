// RSS リーダー + トレンド + 「自分専用 Discover」 のフロントエンド。
//
// app.ts からは loadRssView() を 1 本だけ呼ぶ。 #rssRoot に対して自前で
// 描画・fetch する自己完結モジュール (app.ts の state / DOM に依存しない)。

// ── API 型 (server/rss/types.ts に対応) ──────────────────────────────────────

interface RssFeed {
  id: number;
  url: string;
  kind: 'rss' | 'hatena' | 'google_trends';
  title: string | null;
  category: string | null;
  enabled: number;
  last_status: string | null;
  last_error: string | null;
  last_fetched_at: string | null;
  article_count: number;
  unread_count: number;
}

interface RssArticle {
  id: number;
  feed_id: number;
  url: string;
  title: string;
  summary: string | null;
  author: string | null;
  image_url: string | null;
  meta_json: string | null;
  published_at: string | null;
  ai_score: number | null;
  ai_reason: string | null;
  ai_matched: string | null;
  ai_status: string;
  ai_summary: string | null;
  starred: number;
  read_at: string | null;
  feed_title: string | null;
  feed_kind: 'rss' | 'hatena' | 'google_trends';
  feed_category: string | null;
}

interface RssInterest {
  id: number;
  label: string;
  prompt: string;
  weight: number;
  enabled: number;
}

interface RssPreset {
  label: string;
  url: string;
  kind: string;
  category: string;
  description: string;
}

interface RssConfig {
  enabled: boolean;
  poll_interval_minutes: number;
  auto_score: boolean;
  min_score_notify: number;
  notify_enabled: boolean;
  auto_summarize: boolean;
}

interface RssDigest {
  date: string;
  content: string;
  created_at: string;
}

interface DiscoveredFeed {
  url: string;
  title: string | null;
  kind: string;
  alreadyRegistered: boolean;
}

type SubView = 'digest' | 'discover' | 'latest' | 'starred' | 'feeds' | 'interests' | 'settings';

// ── 小物 ─────────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 最小 Markdown → HTML (見出し / 箇条書き / 太字 / リンク)。 digest 表示用。 */
function miniMarkdown(md: string): string {
  const lines = md.split(/\r?\n/);
  const html: string[] = [];
  let inList = false;
  const inline = (s: string) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) { if (!inList) { html.push('<ul>'); inList = true; } html.push(`<li>${inline(li[1])}</li>`); continue; }
    if (inList) { html.push('</ul>'); inList = false; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { const n = h[1].length; html.push(`<h${n + 2} class="rss-md-h">${inline(h[2])}</h${n + 2}>`); continue; }
    if (!line) { html.push(''); continue; }
    html.push(`<p>${inline(line)}</p>`);
  }
  if (inList) html.push('</ul>');
  return html.join('\n');
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

function relTime(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}日前`;
  return new Date(t).toLocaleDateString('ja-JP');
}

const KIND_BADGE: Record<string, string> = {
  google_trends: '📈 トレンド',
  hatena: '🔖 はてブ',
  rss: '📰 RSS',
};

function scoreBadge(a: RssArticle): string {
  if (a.ai_score == null) {
    if (a.ai_status === 'skip') return '';
    if (a.ai_status === 'pending') return `<span class="rss-score rss-score-pending" title="採点待ち">…</span>`;
    return '';
  }
  const pct = Math.round(a.ai_score * 100);
  const cls = a.ai_score >= 0.7 ? 'rss-score-hi' : a.ai_score >= 0.4 ? 'rss-score-mid' : 'rss-score-lo';
  const title = a.ai_reason ? esc(a.ai_reason) : '';
  return `<span class="rss-score ${cls}" title="${title}">★ ${pct}</span>`;
}

// ── 描画状態 ─────────────────────────────────────────────────────────────────

let inited = false;
let sub: SubView = 'digest';

function root(): HTMLElement | null {
  return document.getElementById('rssRoot');
}

function buildSkeleton(el: HTMLElement): void {
  el.innerHTML = `
    <div class="rss-subnav">
      ${([
        ['digest', '📰 ダイジェスト'],
        ['discover', '✨ ディスカバー'],
        ['latest', '🕐 新着'],
        ['starred', '⭐ スター'],
        ['feeds', '📡 フィード'],
        ['interests', '🎯 興味テーマ'],
        ['settings', '⚙ 設定'],
      ] as [SubView, string][]).map(([k, label]) =>
        `<button class="rss-subnav-btn" data-sub="${k}">${label}</button>`).join('')}
      <span class="grow"></span>
      <button id="rssRefreshAll" class="ghost" title="全フィードを今すぐ取得">⟳ 更新</button>
    </div>
    <div id="rssStatus" class="muted" style="font-size:12px;min-height:16px;margin:4px 2px"></div>
    <div id="rssBody"></div>
  `;
  el.querySelectorAll<HTMLButtonElement>('.rss-subnav-btn').forEach(btn => {
    btn.addEventListener('click', () => { sub = (btn.dataset.sub as SubView) || 'discover'; renderSub(); });
  });
  el.querySelector('#rssRefreshAll')?.addEventListener('click', () => { void refreshAll(); });
}

function setStatus(msg: string): void {
  const s = document.getElementById('rssStatus');
  if (s) s.textContent = msg;
}

function markActiveSubBtn(): void {
  root()?.querySelectorAll<HTMLButtonElement>('.rss-subnav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.sub === sub);
  });
}

async function refreshAll(): Promise<void> {
  setStatus('全フィードを取得中…');
  try {
    const r = await sendJson<{ feeds: number; newArticles: number; scored: number; notified: number; skipped?: boolean }>(
      '/api/rss/refresh', 'POST');
    if (r.skipped) setStatus('別の取得処理が進行中です。少し待って再試行してください。');
    else setStatus(`取得完了: ${r.feeds} フィード / 新着 ${r.newArticles} 件 / 採点 ${r.scored} 件`);
    await renderSub();
  } catch (e) {
    setStatus(`取得失敗: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── 記事カード ────────────────────────────────────────────────────────────────

function trendMeta(a: RssArticle): string {
  if (a.feed_kind !== 'google_trends' || !a.meta_json) return '';
  try {
    const m = JSON.parse(a.meta_json) as { approx_traffic?: string; news?: { title: string; url: string; source: string }[] };
    const traffic = m.approx_traffic ? `<span class="rss-traffic">🔥 ${esc(m.approx_traffic)} 検索</span>` : '';
    const news = (m.news || []).slice(0, 3).map(n =>
      `<a href="${esc(n.url)}" target="_blank" rel="noopener" class="rss-news-link">${esc(n.title)}<span class="muted"> — ${esc(n.source)}</span></a>`).join('');
    return `<div class="rss-trend-meta">${traffic}${news ? `<div class="rss-news">${news}</div>` : ''}</div>`;
  } catch { return ''; }
}

function articleCard(a: RssArticle): string {
  const read = a.read_at ? 'rss-read' : '';
  const matched = a.ai_matched ? `<span class="rss-matched">${esc(a.ai_matched)}</span>` : '';
  return `
    <div class="rss-card ${read}" data-id="${a.id}">
      <div class="rss-card-head">
        ${scoreBadge(a)}
        <a href="${esc(a.url)}" target="_blank" rel="noopener" class="rss-card-title" data-read="${a.id}">${esc(a.title)}</a>
      </div>
      <div class="rss-card-meta">
        <span class="rss-kind">${KIND_BADGE[a.feed_kind] || '📰'}</span>
        <span class="muted">${esc(a.feed_title || '')}</span>
        ${a.published_at ? `<span class="muted">· ${relTime(a.published_at)}</span>` : ''}
        ${matched}
      </div>
      ${a.summary ? `<div class="rss-card-summary">${esc(a.summary)}</div>` : ''}
      ${a.ai_summary ? `<div class="rss-card-aisummary">🧠 ${esc(a.ai_summary)}</div>` : ''}
      ${a.ai_reason ? `<div class="rss-card-reason">💡 ${esc(a.ai_reason)}</div>` : ''}
      ${trendMeta(a)}
      <div class="rss-card-actions">
        <button class="ghost rss-star" data-star="${a.id}">${a.starred ? '⭐' : '☆'}</button>
        <button class="ghost rss-readbtn" data-toggleread="${a.id}">${a.read_at ? '既読を外す' : '既読にする'}</button>
        <button class="ghost rss-summ" data-summarize="${a.id}" title="AI で要約">🧠 要約</button>
        <button class="ghost rss-rescore" data-rescore="${a.id}" title="この記事を再採点">★再採点</button>
      </div>
    </div>`;
}

function bindArticleActions(container: HTMLElement): void {
  container.querySelectorAll<HTMLAnchorElement>('[data-read]').forEach(a => {
    a.addEventListener('click', () => {
      const id = Number(a.dataset.read);
      void sendJson(`/api/rss/articles/${id}/read`, 'POST', { read: true }).catch(() => {});
      a.closest('.rss-card')?.classList.add('rss-read');
    });
  });
  container.querySelectorAll<HTMLButtonElement>('[data-star]').forEach(b => {
    b.addEventListener('click', async () => {
      const id = Number(b.dataset.star);
      const r = await sendJson<{ starred: boolean }>(`/api/rss/articles/${id}/star`, 'POST', {}).catch(() => null);
      if (r) b.textContent = r.starred ? '⭐' : '☆';
    });
  });
  container.querySelectorAll<HTMLButtonElement>('[data-toggleread]').forEach(b => {
    b.addEventListener('click', async () => {
      const id = Number(b.dataset.toggleread);
      const card = b.closest('.rss-card');
      const isRead = card?.classList.contains('rss-read');
      await sendJson(`/api/rss/articles/${id}/read`, 'POST', { read: !isRead }).catch(() => {});
      card?.classList.toggle('rss-read', !isRead);
      b.textContent = !isRead ? '既読を外す' : '既読にする';
    });
  });
  container.querySelectorAll<HTMLButtonElement>('[data-rescore]').forEach(b => {
    b.addEventListener('click', async () => {
      const id = Number(b.dataset.rescore);
      b.textContent = '採点中…';
      await sendJson(`/api/rss/articles/${id}/score`, 'POST', {}).catch(() => {});
      await renderSub();
    });
  });
  container.querySelectorAll<HTMLButtonElement>('[data-summarize]').forEach(b => {
    b.addEventListener('click', async () => {
      const id = Number(b.dataset.summarize);
      b.textContent = '要約中…'; b.disabled = true;
      const r = await sendJson<{ summary?: string }>(`/api/rss/articles/${id}/summarize`, 'POST', {}).catch(() => null);
      const card = b.closest('.rss-card');
      if (r?.summary && card) {
        const div = document.createElement('div');
        div.className = 'rss-card-aisummary';
        div.textContent = `🧠 ${r.summary}`;
        const existing = card.querySelector('.rss-card-aisummary');
        if (existing) existing.replaceWith(div); else card.querySelector('.rss-card-actions')?.before(div);
        b.textContent = '🧠 要約'; b.disabled = false;
      } else {
        b.textContent = '要約失敗'; b.disabled = false;
      }
    });
  });
}

// ── 各サブビュー ──────────────────────────────────────────────────────────────

async function renderArticleList(opts: { sort: 'score' | 'published'; starred?: boolean; empty: string }): Promise<void> {
  const body = document.getElementById('rssBody');
  if (!body) return;
  body.innerHTML = '<div class="muted">読み込み中…</div>';
  const params = new URLSearchParams({ sort: opts.sort, limit: '60' });
  if (opts.starred) params.set('starred', '1');
  try {
    const { items } = await getJson<{ items: RssArticle[] }>(`/api/rss/articles?${params.toString()}`);
    if (!items.length) { body.innerHTML = `<div class="empty">${esc(opts.empty)}</div>`; return; }
    body.innerHTML = `<div class="rss-list">${items.map(articleCard).join('')}</div>`;
    bindArticleActions(body);
  } catch (e) {
    body.innerHTML = `<div class="empty">読み込みに失敗しました: ${esc(e instanceof Error ? e.message : String(e))}</div>`;
  }
}

async function renderFeeds(): Promise<void> {
  const body = document.getElementById('rssBody');
  if (!body) return;
  body.innerHTML = '<div class="muted">読み込み中…</div>';
  const [{ items: feeds }, { items: presets }] = await Promise.all([
    getJson<{ items: RssFeed[] }>('/api/rss/feeds'),
    getJson<{ items: RssPreset[] }>('/api/rss/presets'),
  ]);
  const presetBtns = presets.map((p, i) =>
    `<button class="rss-preset" data-preset="${i}" title="${esc(p.description)}">+ ${esc(p.label)}</button>`).join('');
  const feedRows = feeds.length ? feeds.map(f => `
    <div class="rss-feed-row" data-feed="${f.id}">
      <label class="rss-feed-toggle"><input type="checkbox" data-enable="${f.id}" ${f.enabled ? 'checked' : ''}/></label>
      <div class="rss-feed-main">
        <div class="rss-feed-title">${KIND_BADGE[f.kind] || '📰'} ${esc(f.title || f.url)}</div>
        <div class="muted rss-feed-sub">${esc(f.category || '未分類')} · ${f.article_count} 件 (未読 ${f.unread_count})
          ${f.last_status === 'error' ? `· <span class="rss-err">⚠ ${esc(f.last_error || 'error')}</span>` : ''}
          ${f.last_fetched_at ? `· ${relTime(f.last_fetched_at)}取得` : '· 未取得'}</div>
      </div>
      <button class="ghost" data-refresh="${f.id}" title="今すぐ取得">⟳</button>
      <button class="ghost rss-del" data-del="${f.id}" title="削除">🗑</button>
    </div>`).join('') : '<div class="empty">フィード未登録。下から追加するかプリセットを選んでください。</div>';

  body.innerHTML = `
    <div class="rss-section">
      <h3>フィードを追加</h3>
      <div class="rss-add-form foundation-form">
        <input id="rssAddUrl" type="url" placeholder="RSS / Atom フィードの URL" />
        <input id="rssAddCat" type="text" placeholder="カテゴリ (任意)" style="max-width:160px" />
        <button id="rssAddBtn">+ 追加</button>
      </div>
      <div class="rss-presets">${presetBtns}</div>
    </div>
    <div class="rss-section">
      <h3>サイトURLからRSSを探す</h3>
      <div class="rss-add-form foundation-form">
        <input id="rssDiscUrl" type="url" placeholder="サイトのURL (例: https://example.com)" />
        <button id="rssDiscBtn">探す</button>
      </div>
      <div id="rssDiscResults"></div>
    </div>
    <div class="rss-section">
      <h3>登録済みフィード</h3>
      <div class="rss-feed-list">${feedRows}</div>
    </div>`;

  body.querySelector('#rssAddBtn')?.addEventListener('click', async () => {
    const url = (body.querySelector('#rssAddUrl') as HTMLInputElement)?.value.trim();
    const category = (body.querySelector('#rssAddCat') as HTMLInputElement)?.value.trim();
    if (!url) return;
    setStatus('フィードを登録中…');
    try {
      await sendJson('/api/rss/feeds', 'POST', { url, category: category || undefined });
      setStatus('登録しました。取得中…');
      await renderFeeds();
    } catch (e) { setStatus(`登録失敗: ${e instanceof Error ? e.message : String(e)}`); }
  });
  body.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(b => {
    b.addEventListener('click', async () => {
      const p = presets[Number(b.dataset.preset)];
      if (!p) return;
      setStatus(`「${p.label}」を登録中…`);
      try {
        await sendJson('/api/rss/feeds', 'POST', { url: p.url, kind: p.kind, category: p.category });
        setStatus('登録しました。取得中…');
        await renderFeeds();
      } catch (e) { setStatus(`登録失敗: ${e instanceof Error ? e.message : String(e)}`); }
    });
  });
  body.querySelector('#rssDiscBtn')?.addEventListener('click', async () => {
    const url = (body.querySelector('#rssDiscUrl') as HTMLInputElement)?.value.trim();
    const out = body.querySelector('#rssDiscResults');
    if (!url || !out) return;
    out.innerHTML = '<div class="muted">探索中…</div>';
    try {
      const { items } = await sendJson<{ items: DiscoveredFeed[] }>('/api/rss/discover', 'POST', { url });
      if (!items.length) { out.innerHTML = '<div class="muted">RSS/Atom フィードが見つかりませんでした。</div>'; return; }
      out.innerHTML = items.map((f, i) => `
        <div class="rss-disc-row">
          <span class="rss-feed-title" style="flex:1">${esc(f.title || f.url)}</span>
          ${f.alreadyRegistered
            ? '<span class="muted">登録済み</span>'
            : `<button class="ghost" data-disc="${i}">+ 追加</button>`}
        </div>`).join('');
      out.querySelectorAll<HTMLButtonElement>('[data-disc]').forEach(b => {
        b.addEventListener('click', async () => {
          const f = items[Number(b.dataset.disc)];
          if (!f) return;
          b.textContent = '追加中…'; b.disabled = true;
          await sendJson('/api/rss/feeds', 'POST', { url: f.url, kind: f.kind }).catch(() => {});
          await renderFeeds();
        });
      });
    } catch (e) {
      out.innerHTML = `<div class="muted">探索に失敗しました: ${esc(e instanceof Error ? e.message : String(e))}</div>`;
    }
  });
  body.querySelectorAll<HTMLInputElement>('[data-enable]').forEach(c => {
    c.addEventListener('change', () => {
      void sendJson(`/api/rss/feeds/${c.dataset.enable}`, 'PATCH', { enabled: c.checked }).catch(() => {});
    });
  });
  body.querySelectorAll<HTMLButtonElement>('[data-refresh]').forEach(b => {
    b.addEventListener('click', async () => {
      b.textContent = '…';
      await sendJson(`/api/rss/feeds/${b.dataset.refresh}/refresh`, 'POST', {}).catch(() => {});
      await renderFeeds();
    });
  });
  body.querySelectorAll<HTMLButtonElement>('[data-del]').forEach(b => {
    b.addEventListener('click', async () => {
      if (!confirm('このフィードと記事を削除しますか?')) return;
      await sendJson(`/api/rss/feeds/${b.dataset.del}`, 'DELETE').catch(() => {});
      await renderFeeds();
    });
  });
}

async function renderInterests(): Promise<void> {
  const body = document.getElementById('rssBody');
  if (!body) return;
  body.innerHTML = '<div class="muted">読み込み中…</div>';
  const { items } = await getJson<{ items: RssInterest[] }>('/api/rss/interests');
  const rows = items.length ? items.map(it => `
    <div class="rss-interest-row" data-int="${it.id}">
      <label class="rss-feed-toggle"><input type="checkbox" data-ienable="${it.id}" ${it.enabled ? 'checked' : ''}/></label>
      <div class="rss-feed-main">
        <div class="rss-feed-title">🎯 ${esc(it.label)} <span class="muted">×${it.weight}</span></div>
        <div class="muted rss-feed-sub">${esc(it.prompt)}</div>
      </div>
      <button class="ghost rss-del" data-idel="${it.id}" title="削除">🗑</button>
    </div>`).join('') : '<div class="empty">興味テーマ未設定。テーマを追加すると AI が記事をあなた好みに採点します。</div>';

  body.innerHTML = `
    <div class="rss-section">
      <h3>興味テーマを追加 <span class="muted" style="font-weight:normal">（Feedly Leo 風の AI フィード）</span></h3>
      <div class="rss-add-form foundation-form" style="flex-wrap:wrap">
        <input id="rssIntLabel" type="text" placeholder="テーマ名 (例: 生成AIのビジネス活用)" />
        <input id="rssIntWeight" type="number" min="0" max="2" step="0.1" value="1.0" style="max-width:90px" title="重み" />
        <textarea id="rssIntPrompt" placeholder="どんな記事を見たいか具体的に (例: 企業の生成AI導入事例・規制・新製品。 ポエムや求人は不要)" style="flex:1 1 100%;min-height:64px"></textarea>
        <button id="rssIntAdd">+ 追加</button>
      </div>
    </div>
    <div class="rss-section">
      <div style="display:flex;align-items:center;gap:8px">
        <h3 style="margin:0">登録済みテーマ</h3>
        <span class="grow"></span>
        <button id="rssRescore" class="ghost" title="全記事をこのテーマで採点し直す">↻ 全記事を再採点</button>
      </div>
      <div class="rss-interest-list">${rows}</div>
    </div>`;

  body.querySelector('#rssIntAdd')?.addEventListener('click', async () => {
    const label = (body.querySelector('#rssIntLabel') as HTMLInputElement)?.value.trim();
    const prompt = (body.querySelector('#rssIntPrompt') as HTMLTextAreaElement)?.value.trim();
    const weight = Number((body.querySelector('#rssIntWeight') as HTMLInputElement)?.value) || 1.0;
    if (!label || !prompt) { setStatus('テーマ名と説明を入力してください'); return; }
    await sendJson('/api/rss/interests', 'POST', { label, prompt, weight }).catch(() => {});
    await renderInterests();
  });
  body.querySelector('#rssRescore')?.addEventListener('click', async () => {
    setStatus('全記事を再採点キューに投入しました（バックグラウンド処理中）…');
    await sendJson('/api/rss/rescore', 'POST', {}).catch(() => {});
  });
  body.querySelectorAll<HTMLInputElement>('[data-ienable]').forEach(c => {
    c.addEventListener('change', () => {
      void sendJson(`/api/rss/interests/${c.dataset.ienable}`, 'PATCH', { enabled: c.checked }).catch(() => {});
    });
  });
  body.querySelectorAll<HTMLButtonElement>('[data-idel]').forEach(b => {
    b.addEventListener('click', async () => {
      await sendJson(`/api/rss/interests/${b.dataset.idel}`, 'DELETE').catch(() => {});
      await renderInterests();
    });
  });
}

async function renderSettings(): Promise<void> {
  const body = document.getElementById('rssBody');
  if (!body) return;
  const cfg = await getJson<RssConfig>('/api/rss/settings');
  body.innerHTML = `
    <div class="rss-section foundation-form">
      <h3>RSS 設定</h3>
      <label class="rss-setting"><input type="checkbox" id="rssCfgEnabled" ${cfg.enabled ? 'checked' : ''}/> 定期取得を有効にする</label>
      <label class="rss-setting">取得間隔（分）
        <input type="number" id="rssCfgInterval" min="5" max="1440" value="${cfg.poll_interval_minutes}" style="max-width:100px"/></label>
      <label class="rss-setting"><input type="checkbox" id="rssCfgAutoScore" ${cfg.auto_score ? 'checked' : ''}/> 新着を自動で AI 採点する</label>
      <label class="rss-setting"><input type="checkbox" id="rssCfgAutoSumm" ${cfg.auto_summarize ? 'checked' : ''}/> 高スコア新着を自動で AI 要約する (コスト増)</label>
      <label class="rss-setting"><input type="checkbox" id="rssCfgNotify" ${cfg.notify_enabled ? 'checked' : ''}/> 高スコア記事を push 通知する</label>
      <label class="rss-setting">通知の閾値（0〜1）
        <input type="number" id="rssCfgThreshold" min="0" max="1" step="0.05" value="${cfg.min_score_notify}" style="max-width:100px"/></label>
      <button id="rssCfgSave">保存</button>
    </div>`;
  body.querySelector('#rssCfgSave')?.addEventListener('click', async () => {
    const patch = {
      enabled: (body.querySelector('#rssCfgEnabled') as HTMLInputElement).checked,
      poll_interval_minutes: Number((body.querySelector('#rssCfgInterval') as HTMLInputElement).value),
      auto_score: (body.querySelector('#rssCfgAutoScore') as HTMLInputElement).checked,
      auto_summarize: (body.querySelector('#rssCfgAutoSumm') as HTMLInputElement).checked,
      notify_enabled: (body.querySelector('#rssCfgNotify') as HTMLInputElement).checked,
      min_score_notify: Number((body.querySelector('#rssCfgThreshold') as HTMLInputElement).value),
    };
    await sendJson('/api/rss/settings', 'PATCH', patch).catch(() => {});
    setStatus('設定を保存しました');
  });
}

async function renderDigest(): Promise<void> {
  const body = document.getElementById('rssBody');
  if (!body) return;
  body.innerHTML = '<div class="muted">読み込み中…</div>';
  const { digest } = await getJson<{ digest: RssDigest | null }>('/api/rss/digest').catch(() => ({ digest: null }));
  const genBtn = `<button id="rssDigestGen" class="ghost">${digest ? '↻ 再生成' : '✨ ダイジェストを生成'}</button>`;
  const header = `<div class="rss-section" style="display:flex;align-items:center;gap:8px">
      <h3 style="margin:0">📰 今日のダイジェスト</h3>
      ${digest ? `<span class="muted">${esc(digest.date)}</span>` : ''}
      <span class="grow"></span>${genBtn}
    </div>`;
  body.innerHTML = header + (digest
    ? `<div class="rss-digest">${miniMarkdown(digest.content)}</div>`
    : `<div class="empty">まだダイジェストがありません。上のボタンで、直近の上位記事から「今日のまとめ」を生成できます。</div>`);
  body.querySelector('#rssDigestGen')?.addEventListener('click', async () => {
    setStatus('ダイジェストを生成中… (記事数により少し時間がかかります)');
    const btn = body.querySelector('#rssDigestGen') as HTMLButtonElement;
    if (btn) { btn.textContent = '生成中…'; btn.disabled = true; }
    const r = await sendJson<{ digest?: RssDigest; error?: string }>('/api/rss/digest', 'POST', {}).catch((e) => ({ error: String(e) }));
    if (r && 'digest' in r && r.digest) { setStatus('ダイジェストを生成しました'); await renderDigest(); }
    else { setStatus(`生成できませんでした: ${r?.error || ''}`); if (btn) { btn.textContent = '✨ 再試行'; btn.disabled = false; } }
  });
}

async function renderSub(): Promise<void> {
  markActiveSubBtn();
  switch (sub) {
    case 'digest': return renderDigest();
    case 'discover': return renderArticleList({ sort: 'score', empty: '記事がありません。フィードを登録し、興味テーマを設定してください。' });
    case 'latest': return renderArticleList({ sort: 'published', empty: 'まだ記事がありません。フィードを登録してください。' });
    case 'starred': return renderArticleList({ sort: 'published', starred: true, empty: 'スターを付けた記事はまだありません。' });
    case 'feeds': return renderFeeds();
    case 'interests': return renderInterests();
    case 'settings': return renderSettings();
  }
}

/** app.ts の switchTab('rss') から呼ばれるエントリポイント。 */
export function loadRssView(): void {
  const el = root();
  if (!el) return;
  if (!inited) { buildSkeleton(el); inited = true; }
  void renderSub();
}
