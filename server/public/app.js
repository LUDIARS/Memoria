const state = {
  bookmarks: [],
  categories: [],
  category: null,
  selected: new Set(),
  detailId: null,
  search: '',
  sort: 'created_desc',
  tab: 'bookmarks',
  queue: { items: [], history: [] },
  visits: [],
  visitsSelected: new Set(),
  visitsRange: '7',
  trendsRange: '30',
  recommendations: [],
  digSession: null,
  digHistory: [],
  digSelected: new Set(),
  digPolling: null,
  cloud: null,           // {id, status, label, result, parent_cloud_id, parent_word, origin, ...}
  cloudPolling: null,
  cloudShowDropped: false,
  cloudGraph: null,
  detailCloud: null,     // word cloud for the currently open bookmark detail
  detailCloudPolling: null,
  cloudDictMode: false,
  cloudSiblings: [],
  dictEntries: [],
  dictDetail: null,
  dictSearch: '',
  diaryMonth: null,         // 'YYYY-MM' currently shown in calendar
  diaryEntries: [],
  diaryDetail: null,        // {date, summary, notes, status, metrics, github_commits, live_metrics}
  diaryDetailDate: null,
  diaryPolling: null,
  weeklyEntries: [],
  weeklyDetail: null,
  weeklyDetailWeek: null,
  weeklyPolling: null,
  domainEntries: [],
  domainDetail: null,
  domainSearch: '',
};

const $ = (id) => document.getElementById(id);

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(()=>'')}`);
  return res.json();
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

async function load() {
  const q = new URLSearchParams();
  if (state.category) q.set('category', state.category);
  if (state.sort) q.set('sort', state.sort);
  const [{ items: bookmarks }, { items: categories }] = await Promise.all([
    api(`/api/bookmarks?${q.toString()}`),
    api('/api/categories'),
  ]);
  state.bookmarks = bookmarks;
  state.categories = categories;
  render();
}

function render() {
  renderCategories();
  renderCards();
  renderBulk();
  if (state.detailId != null) renderDetail();
}

function renderCategories() {
  const ul = $('categoryList');
  const total = state.bookmarks.length;
  let html = '';
  html += `<li class="${state.category === null ? 'active' : ''}" data-cat="">すべて<span class="count">${total}</span></li>`;
  for (const c of state.categories) {
    const active = state.category === c.category ? 'active' : '';
    html += `<li class="${active}" data-cat="${escapeHtml(c.category)}">
      ${escapeHtml(c.category)}<span class="count">${c.count}</span>
    </li>`;
  }
  ul.innerHTML = html;
  ul.querySelectorAll('li').forEach(li => {
    li.addEventListener('click', () => {
      const cat = li.dataset.cat || null;
      state.category = cat;
      // Mobile drawer: collapse after picking.
      $('bookmarksView')?.classList.remove('cat-open');
      load();
    });
  });
}

// Mobile only: ☰ カテゴリ in the bookmarks toolbar toggles a floating
// drawer over the cards. Clicking outside the drawer (and not on the
// toggle itself) closes it.
function setupCategoriesDrawer() {
  const toggle = $('categoriesToggle');
  const view = $('bookmarksView');
  const drawer = $('bookmarksCategories');
  if (!toggle || !view || !drawer) return;
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !view.classList.contains('cat-open');
    view.classList.toggle('cat-open', willOpen);
    toggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  });
  document.addEventListener('click', (e) => {
    if (!view.classList.contains('cat-open')) return;
    if (e.target.closest('#bookmarksCategories, #categoriesToggle')) return;
    view.classList.remove('cat-open');
    toggle.setAttribute('aria-expanded', 'false');
  });
}

function renderCards() {
  const wrap = $('cards');
  const empty = $('empty');
  const search = state.search.toLowerCase();
  const items = state.bookmarks.filter(b => {
    if (!search) return true;
    const haystack = `${b.title} ${b.url} ${b.summary ?? ''} ${(b.categories||[]).join(' ')}`.toLowerCase();
    return haystack.includes(search);
  });
  if (items.length === 0) {
    wrap.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  wrap.innerHTML = items.map(b => {
    const isSel = state.selected.has(b.id);
    const statusBadge = b.status === 'pending' ? '<span class="status-pending">要約中</span>'
      : b.status === 'error' ? '<span class="status-error">要約失敗</span>' : '';
    return `
      <div class="card ${isSel ? 'selected' : ''}" data-id="${b.id}">
        <input type="checkbox" class="check" data-id="${b.id}" ${isSel ? 'checked' : ''} />
        <div class="title">${escapeHtml(b.title)}</div>
        <div class="url">${escapeHtml(b.url)}</div>
        <div class="summary">${escapeHtml(b.summary || '')}</div>
        <div class="cats">${(b.categories||[]).map(c => `<span class="cat">${escapeHtml(c)}</span>`).join('')}</div>
        <div class="footer">
          <span>追加: ${fmtDate(b.created_at)}</span>
          <span>${b.access_count ?? 0} 回</span>
        </div>
        <div class="footer">
          <span>最終: ${fmtDate(b.last_accessed_at)}</span>
          <span>${statusBadge}</span>
        </div>
      </div>`;
  }).join('');
  wrap.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('check')) return;
      openDetail(Number(card.dataset.id));
    });
  });
  wrap.querySelectorAll('.check').forEach(cb => {
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(cb.dataset.id);
      if (cb.checked) state.selected.add(id); else state.selected.delete(id);
      renderBulk();
      cb.closest('.card').classList.toggle('selected', cb.checked);
    });
  });
}

function renderBulk() {
  const bar = $('bulkBar');
  $('bulkCount').textContent = state.selected.size;
  bar.classList.toggle('hidden', state.selected.size === 0);
}

async function openDetail(id) {
  state.detailId = id;
  await renderDetail();
  $('detail').classList.remove('hidden');
}

async function renderDetail() {
  const id = state.detailId;
  if (id == null) return;
  const b = await api(`/api/bookmarks/${id}`);
  const accesses = await api(`/api/bookmarks/${id}/accesses`);
  $('dTitle').textContent = b.title;
  const url = $('dUrl');
  url.textContent = b.url;
  url.href = b.url;
  $('dCreated').textContent = fmtDate(b.created_at);
  $('dAccessed').textContent = fmtDate(b.last_accessed_at);
  $('dCount').textContent = b.access_count ?? 0;
  $('dStatus').textContent = b.status + (b.error ? ` (${b.error})` : '');
  $('dSummary').textContent = b.summary || '(要約なし)';
  $('dCategories').value = (b.categories || []).join(', ');
  $('dMemo').value = b.memo || '';
  $('dViewHtml').href = `/api/bookmarks/${id}/html`;
  $('dAccesses').innerHTML = (accesses.items || []).map(a => `<li>${fmtDate(a.accessed_at)}</li>`).join('');
  state.detailCloud = b.wordcloud || null;
  renderDetailCloud();
}

function renderDetailCloud() {
  const el = $('dCloud');
  if (!el) return;
  const wc = state.detailCloud;
  if (!wc) {
    el.innerHTML = '<div class="detail-cloud-empty">未生成。生成ボタンを押すと、この記事から claude が抽出します。</div>';
    return;
  }
  if (wc.status === 'pending') {
    el.innerHTML = '<div class="detail-cloud-empty">抽出中…</div>';
    return;
  }
  if (wc.status === 'error') {
    el.innerHTML = `<div class="detail-cloud-empty" style="color:var(--danger)">失敗: ${escapeHtml(wc.error || '不明')}</div>`;
    return;
  }
  const r = wc.result || {};
  const kept = (r.words || []).filter(w => w.kept);
  el.innerHTML = renderCloudWords(kept);
  el.querySelectorAll('.cloud-word').forEach(w => {
    w.addEventListener('click', () => onCloudWordClick(w.dataset.word));
  });
}

async function generateDetailCloud() {
  const id = state.detailId;
  if (id == null) return;
  const btn = $('dCloudGen');
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  try {
    const r = await api(`/api/bookmarks/${id}/wordcloud`, { method: 'POST' });
    state.detailCloud = { id: r.id, status: 'pending', result: null };
    renderDetailCloud();
    pollDetailCloud(r.id);
  } catch (e) {
    alert(`生成失敗: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '生成'; }
  }
}

function pollDetailCloud(cloudId) {
  if (state.detailCloudPolling) clearInterval(state.detailCloudPolling);
  state.detailCloudPolling = setInterval(async () => {
    const c = await api(`/api/wordcloud/${cloudId}`).catch(() => null);
    if (!c || c.status === 'pending') return;
    clearInterval(state.detailCloudPolling);
    state.detailCloudPolling = null;
    state.detailCloud = c;
    renderDetailCloud();
  }, 5000);
}

function closeDetail() {
  state.detailId = null;
  $('detail').classList.add('hidden');
}

async function saveDetail() {
  const id = state.detailId;
  if (id == null) return;
  const memo = $('dMemo').value;
  const cats = $('dCategories').value.split(',').map(s => s.trim()).filter(Boolean);
  await api(`/api/bookmarks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memo, categories: cats }),
  });
  await load();
}

async function resummarizeDetail() {
  const id = state.detailId;
  if (id == null) return;
  const btn = $('dResummarize');
  btn.disabled = true;
  btn.textContent = '要求中...';
  try {
    await api(`/api/bookmarks/${id}/resummarize`, { method: 'POST' });
    await renderDetail();
    await load();
  } catch (e) {
    alert(`再要約に失敗: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '再要約';
  }
}

async function deleteDetail() {
  const id = state.detailId;
  if (id == null) return;
  if (!confirm('このブックマークを削除しますか？')) return;
  await api(`/api/bookmarks/${id}`, { method: 'DELETE' });
  closeDetail();
  state.selected.delete(id);
  await load();
}

async function exportSelected() {
  const ids = [...state.selected];
  if (ids.length === 0) {
    if (!confirm('選択がありません。すべてエクスポートしますか？')) return;
  }
  const body = ids.length > 0 ? { ids } : {};
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { alert('export failed'); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `memoria-export-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importFile(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch { alert('JSON が壊れています'); return; }
  const bookmarks = data.bookmarks || data;
  if (!Array.isArray(bookmarks)) { alert('bookmarks 配列が見つかりません'); return; }
  const r = await api('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookmarks }),
  });
  alert(`取り込み完了: ${r.imported} 件 / スキップ ${r.skipped} 件`);
  await load();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ---- wire up ---------------------------------------------------------------

$('search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderCards();
});
$('sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  load();
});
$('detailClose').addEventListener('click', closeDetail);
$('dSave').addEventListener('click', saveDetail);
$('dResummarize').addEventListener('click', resummarizeDetail);
$('dDelete').addEventListener('click', deleteDetail);
$('dCloudGen')?.addEventListener('click', generateDetailCloud);
$('exportBtn').addEventListener('click', exportSelected);
$('bulkExport').addEventListener('click', exportSelected);
$('bulkClear').addEventListener('click', () => {
  state.selected.clear();
  renderCards();
  renderBulk();
});
$('importInput').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (f) await importFile(f);
  e.target.value = '';
});

load().catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend',
    `<div style="padding:32px;color:#c33">サーバーに接続できません: ${err.message}</div>`);
});

async function refreshVisitsBadge() {
  try {
    const r = await api('/api/visits/unsaved/count');
    const badge = $('tabVisitsCount');
    if (r.count > 0) {
      badge.classList.remove('hidden');
      badge.textContent = r.count;
    } else {
      badge.classList.add('hidden');
    }
  } catch {}
}

async function refreshQueue() {
  try {
    const snap = await api('/api/queue/items');
    state.queue = snap;
    // Sum depth across all groups for the top-bar badge.
    const groups = ['summary','dig','wordcloud','diary','weekly','domain','page'];
    let totalDepth = 0;
    for (const g of groups) {
      const s = snap[g];
      if (s) totalDepth += (s.items?.length || 0);
    }
    if (totalDepth === 0) totalDepth = snap.depth || 0;
    const badge = $('queueBadge');
    const tabCount = $('tabQueueCount');
    if (totalDepth > 0) {
      badge.classList.remove('hidden');
      tabCount.classList.remove('hidden');
      $('queueCount').textContent = totalDepth;
      tabCount.textContent = totalDepth;
    } else {
      badge.classList.add('hidden');
      tabCount.classList.add('hidden');
    }
    if (state.tab === 'queue') renderQueue();
    return totalDepth;
  } catch { return 0; }
}

function fmtElapsed(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m ${r}s`;
}

const QUEUE_GROUP_LABELS = {
  summary:   '📑 ブックマーク要約',
  dig:       '🔎 ディグ (deep research)',
  wordcloud: '🌐 ワードクラウド',
  diary:     '📅 日記',
  weekly:    '📆 週報',
  domain:    '🏷 ドメイン分類',
  page:      '📄 ページメタ',
};

function collectQueueJobs(snap) {
  const all = [];
  for (const key of Object.keys(QUEUE_GROUP_LABELS)) {
    const g = snap?.[key];
    if (!g) continue;
    for (const it of (g.items || [])) all.push({ ...it, group: key });
    for (const it of (g.history || [])) all.push({ ...it, group: key, _history: true });
  }
  return all;
}

function renderQueue() {
  const snap = state.queue || {};
  const jobs = collectQueueJobs(snap);
  const running = jobs.find(j => !j._history && j.status === 'running');
  const queued = jobs.filter(j => !j._history && j.status === 'queued');
  const history = jobs
    .filter(j => j._history)
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
    .slice(0, 30);

  const runEl = $('queueRunning');
  if (runEl) {
    if (!running) {
      runEl.innerHTML = '<div class="queue-empty">作業はありません</div>';
    } else {
      const elapsed = running.startedAt ? Date.now() - running.startedAt : 0;
      runEl.innerHTML = `
        <div class="qg-row running">
          <div class="pulse"></div>
          <div class="qg-row-body">
            <div class="qg-tag">${escapeHtml(QUEUE_GROUP_LABELS[running.group] || running.group)}</div>
            <div class="title">${escapeHtml(jobLabel(running))}</div>
            <div class="meta">経過 ${fmtElapsed(elapsed)} · seq #${running.seq}</div>
          </div>
        </div>
      `;
    }
  }

  const waitEl = $('queueWaiting');
  if (waitEl) {
    if (queued.length === 0) {
      waitEl.innerHTML = '';
    } else {
      const counts = {};
      for (const q of queued) counts[q.group] = (counts[q.group] || 0) + 1;
      const summary = Object.entries(counts)
        .map(([k, n]) => `<span class="qw-pill">${escapeHtml(QUEUE_GROUP_LABELS[k] || k)} <b>${n}</b></span>`)
        .join('');
      waitEl.innerHTML = `<div class="qw-summary">待機中 (${queued.length}): ${summary}</div>`;
    }
  }

  const histEl = $('queueHistory');
  if (histEl) {
    if (history.length === 0) {
      histEl.innerHTML = '<div class="queue-empty">履歴はまだありません</div>';
    } else {
      histEl.innerHTML = history.map(i => {
        const dur = i.startedAt && i.finishedAt ? i.finishedAt - i.startedAt : null;
        const ok = i.status === 'done';
        return `
          <div class="qg-row history">
            <div class="qg-icon ${ok ? 'done' : 'error'}">${ok ? '✓' : '✗'}</div>
            <div class="qg-row-body">
              <div class="qg-tag">${escapeHtml(QUEUE_GROUP_LABELS[i.group] || i.group)}</div>
              <div class="title">${escapeHtml(jobLabel(i))}</div>
              ${i.error ? `<div class="err">${escapeHtml(i.error)}</div>` : ''}
            </div>
            <div class="duration">${fmtElapsed(dur)}</div>
          </div>
        `;
      }).join('');
    }
  }
}

function jobLabel(item) {
  const title = item.title || '';
  const kindHint = item.kind ? `[${item.kind}] ` : '';
  if (title) return kindHint + title;
  if (item.bookmarkId != null) return `${kindHint}bookmark #${item.bookmarkId}`;
  if (item.sessionId != null) return `${kindHint}dig #${item.sessionId}`;
  if (item.cloudId != null) return `${kindHint}cloud #${item.cloudId}`;
  if (item.date) return `${kindHint}${item.date}`;
  if (item.weekStart) return `${kindHint}${item.weekStart}`;
  if (item.domain) return `${kindHint}${item.domain}`;
  if (item.url) return `${kindHint}${item.url}`;
  return kindHint + `seq #${item.seq}`;
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  const layout = document.querySelector('.layout');
  if (layout) layout.dataset.activeTab = tab;
  $('bookmarksView').classList.toggle('hidden', tab !== 'bookmarks');
  $('queueView').classList.toggle('hidden', tab !== 'queue');
  $('visitsView').classList.toggle('hidden', tab !== 'visits');
  $('trendsView').classList.toggle('hidden', tab !== 'trends');
  $('recommendView').classList.toggle('hidden', tab !== 'recommend');
  $('digView').classList.toggle('hidden', tab !== 'dig');
  $('dictView').classList.toggle('hidden', tab !== 'dict');
  $('domainView').classList.toggle('hidden', tab !== 'domain');
  $('diaryView').classList.toggle('hidden', tab !== 'diary');
  $('eventsView').classList.toggle('hidden', tab !== 'events');
  $('multiView')?.classList.toggle('hidden', tab !== 'multi');
  if (tab === 'queue') renderQueue();
  if (tab === 'visits') loadVisits();
  if (tab === 'trends') loadTrends();
  if (tab === 'recommend') loadRecommendations();
  if (tab === 'dig') loadDigHistory();
  if (tab === 'dict') loadDictionary();
  if (tab === 'domain') loadDomainCatalog();
  if (tab === 'diary') loadDiary();
  if (tab === 'events') loadEvents();
  if (tab === 'multi') loadMulti();
  // Keep mobile tab select in sync with the active tab.
  const sel = $('mobileTabSelect');
  if (sel && sel.value !== tab) sel.value = tab;
  bumpTabUsage(tab);
  reflowTabsForViewport();
  closeTabMoreMenu();
}

// ── Tab use-count + mobile More menu ──────────────────────────────────────
const TAB_USAGE_KEY = 'memoria.tabUsage.v1';
function readTabUsage() {
  try { return JSON.parse(localStorage.getItem(TAB_USAGE_KEY)) || {}; } catch { return {}; }
}
function bumpTabUsage(tab) {
  const u = readTabUsage();
  u[tab] = (u[tab] || 0) + 1;
  try { localStorage.setItem(TAB_USAGE_KEY, JSON.stringify(u)); } catch {}
}
function tabsInUsageOrder() {
  const tabs = [...document.querySelectorAll('.tabs-scroll .tab[data-tab]')];
  const u = readTabUsage();
  return tabs.slice().sort((a, b) => (u[b.dataset.tab] || 0) - (u[a.dataset.tab] || 0));
}
function closeTabMoreMenu() {
  const m = $('tabMoreMenu');
  const b = $('tabMoreBtn');
  if (m) m.classList.add('hidden');
  if (b) b.setAttribute('aria-expanded', 'false');
}
function reflowTabsForViewport() {
  const scroll = document.querySelector('.tabs-scroll');
  const moreWrap = document.querySelector('.tabs-more');
  const moreMenu = $('tabMoreMenu');
  if (!scroll || !moreWrap || !moreMenu) return;

  const allTabs = [...scroll.querySelectorAll('.tab[data-tab]')];

  // Reset every state from any previous run.
  for (const t of allTabs) t.style.display = '';
  moreMenu.replaceChildren();

  const isNarrow = window.innerWidth <= 760;
  if (!isNarrow) {
    moreWrap.classList.add('hidden');
    return;
  }

  const active = state.tab;
  const ordered = tabsInUsageOrder();
  const visibleN = 4;
  const visible = new Set(ordered.slice(0, visibleN).map(t => t.dataset.tab));
  if (active) visible.add(active);

  let overflowCount = 0;
  for (const t of allTabs) {
    if (visible.has(t.dataset.tab)) {
      t.style.display = '';
    } else {
      // Build a fresh button instead of cloning — cloneNode used to
      // copy the `display: none` we set on the original, which made
      // the More menu silently empty.
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'tab' + (t.dataset.tab === active ? ' active' : '');
      item.dataset.tab = t.dataset.tab;
      item.textContent = (t.textContent || t.dataset.tab).trim();
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        switchTab(t.dataset.tab);
      });
      moreMenu.appendChild(item);
      t.style.display = 'none';
      overflowCount += 1;
    }
  }
  moreWrap.classList.toggle('hidden', overflowCount === 0);
}

// ── Dig (deep research) ──────────────────────────────────────────────────

async function loadDigHistory() {
  try {
    const { items } = await api('/api/dig');
    state.digHistory = items;
    renderDigHistory();
    if (!state.digEnginesLoaded) loadDigEngines();
  } catch (e) { console.error(e); }
}

async function loadDigEngines() {
  try {
    const { items } = await api('/api/dig/engines');
    const sel = $('digEngine');
    if (!sel) return;
    sel.innerHTML = items.map(e => `<option value="${e.key}">${escapeHtml(e.label)}</option>`).join('');
    state.digEnginesLoaded = true;
  } catch (e) { console.error(e); }
}

function renderDigHistory() {
  const el = $('digHistory');
  if (!state.digHistory.length) {
    el.innerHTML = '<span style="color:var(--muted);font-size:11px">過去のディグなし</span>';
    return;
  }
  el.innerHTML = state.digHistory.map(s =>
    `<span class="pill ${s.status}" data-id="${s.id}" title="${escapeHtml(s.created_at)}">
      ${escapeHtml(s.query.slice(0, 30))}${s.query.length > 30 ? '…' : ''}
    </span>`
  ).join('');
  el.querySelectorAll('.pill').forEach(p => {
    p.addEventListener('click', () => loadDigSession(Number(p.dataset.id)));
  });
}

async function startDig({ chainCloudId, chainParentWord } = {}) {
  const q = $('digQuery').value.trim();
  if (!q) return;
  $('digRun').disabled = true;
  $('digRun').textContent = '掘削中…';
  try {
    const engineSel = $('digEngine');
    const search_engine = engineSel ? engineSel.value : 'default';
    const r = await api('/api/dig', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, search_engine }),
    });
    state.digChain = {
      cloudId: chainCloudId ?? null,
      parentWord: chainParentWord ?? null,
    };
    await loadDigHistory();
    pollDigSession(r.id);
  } catch (e) {
    alert(`dig 失敗: ${e.message}`);
  } finally {
    $('digRun').disabled = false;
    $('digRun').textContent = 'ディグる';
  }
}

function pollDigSession(id) {
  if (state.digPolling) clearInterval(state.digPolling);
  loadDigSession(id);
  // Poll faster while waiting for preview, then settle.
  state.digPolling = setInterval(async () => {
    const s = await api(`/api/dig/${id}`).catch(() => null);
    if (!s) return;
    const had = state.digSession;
    state.digSession = s;
    const previewArrived = !had?.preview && !!s.preview;
    if (previewArrived) renderDigSession();
    if (s.status !== 'pending') {
      clearInterval(state.digPolling);
      state.digPolling = null;
      renderDigSession();
      loadDigHistory();
    }
  }, 2000);
}

async function loadDigSession(id) {
  try {
    const s = await api(`/api/dig/${id}`);
    state.digSession = s;
    state.digSelected = new Set();
    renderDigSession();
    if (s.status === 'pending') pollDigSession(id);
  } catch (e) { console.error(e); }
}

function renderDigSession() {
  const s = state.digSession;
  const el = $('digResult');
  const shareBar = $('digShareBar');
  if (shareBar) shareBar.hidden = !(s && s.status === 'done' && state.multi?.connected);
  if ($('digShareStatus')) $('digShareStatus').textContent = '';
  if (!s) { el.innerHTML = ''; return; }
  if (s.status === 'pending') {
    if (s.preview) {
      el.innerHTML = renderDigPreview(s) + `<div class="dig-pending dig-pending-tight"><div class="pulse"></div>詳細解析を続行中…完了するとさらに整理された結果が表示されます。</div>`;
    } else {
      el.innerHTML = `<div class="dig-pending"><div class="pulse"></div>「${escapeHtml(s.query)}」を検索中…まずは Google の AI overview と上位結果のみを取得し、続けて詳細を解析します。</div>`;
    }
    return;
  }
  if (s.status === 'error') {
    el.innerHTML = `<div class="dig-pending" style="border-color:var(--danger);color:var(--danger)">エラー: ${escapeHtml(s.error || '不明')}</div>`;
    return;
  }
  const r = s.result || {};
  const sources = r.sources || [];
  const summaryBlock = r.summary
    ? `<div class="summary">${escapeHtml(r.summary)}</div>`
    : '';
  const graph = sources.length > 0 ? digGraph(s.query, sources) : '';
  const sourceCards = sources.map((src, i) => {
    const sel = state.digSelected.has(src.url);
    const topics = (src.topics || []).map(t => `<span class="topic">${escapeHtml(t)}</span>`).join('');
    return `
      <div class="dig-source ${sel ? 'selected' : ''}" data-url="${escapeHtml(src.url)}" data-i="${i}">
        <div class="top-line">
          <input type="checkbox" class="dig-chk" ${sel ? 'checked' : ''} />
          <div class="title">${escapeHtml(src.title)}</div>
        </div>
        <div class="url"><a href="${escapeHtml(src.url)}" target="_blank" rel="noreferrer">${escapeHtml(src.url)}</a></div>
        <div class="snippet">${escapeHtml(src.snippet)}</div>
        <div class="topics">${topics}</div>
      </div>
    `;
  }).join('');
  const chain = state.digChain || {};
  const chainHint = chain.parentWord
    ? `<span class="dig-chain-hint">親 "${escapeHtml(chain.parentWord)}" から派生</span>`
    : '';
  el.innerHTML = `
    ${summaryBlock}
    ${graph}
    <div class="dig-actions">
      <span id="digSelCount">0</span> 件選択中
      ${chainHint}
      <span class="grow"></span>
      <button id="digCloudBtn" class="ghost" title="このディグの記事からワードクラウドを生成">🌐 このディグから雲を抽出</button>
      <button id="digDictBtn" class="ghost" title="このディグを辞書エントリとして記録">📖 辞書に追加</button>
      <button id="digSaveBtn">選択をブックマーク化</button>
    </div>
    <div class="dig-sources">${sourceCards}</div>
  `;
  el.querySelectorAll('.dig-source').forEach(card => {
    const url = card.dataset.url;
    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      if (e.target.tagName !== 'INPUT') {
        const cb = card.querySelector('.dig-chk');
        cb.checked = !cb.checked;
      }
      const sel = card.querySelector('.dig-chk').checked;
      if (sel) state.digSelected.add(url); else state.digSelected.delete(url);
      card.classList.toggle('selected', sel);
      $('digSelCount').textContent = state.digSelected.size;
    });
  });
  $('digCloudBtn')?.addEventListener('click', () => {
    const chain = state.digChain || {};
    startCloudFromDig(s.id, chain.cloudId, chain.parentWord);
  });
  $('digDictBtn')?.addEventListener('click', () => addDigToDictionary(s));
  $('digSaveBtn')?.addEventListener('click', async () => {
    const urls = [...state.digSelected];
    if (!urls.length) return;
    $('digSaveBtn').disabled = true;
    try {
      const r = await api(`/api/dig/${s.id}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
      const ok = r.results.filter(x => x.status === 'queued').length;
      alert(`${ok} 件をブックマーク化しました (キュー投入)。`);
      state.digSelected.clear();
      renderDigSession();
      await refreshQueue();
    } finally {
      const btn = $('digSaveBtn');
      if (btn) btn.disabled = false;
    }
  });
}

function digGraph(query, sources) {
  const w = 700, h = 360, cx = w / 2, cy = h / 2, r = 130;
  const center = { x: cx, y: cy, label: query.slice(0, 24), klass: 'center', size: 10 };
  const nodes = sources.map((s, i) => {
    const a = (i / sources.length) * Math.PI * 2 - Math.PI / 2;
    return {
      x: cx + Math.cos(a) * r,
      y: cy + Math.sin(a) * r,
      label: shortDomain(s.url),
      klass: '',
      size: 6,
    };
  });
  const edges = nodes.map(n =>
    `<line class="edge" x1="${cx}" y1="${cy}" x2="${n.x.toFixed(1)}" y2="${n.y.toFixed(1)}" />`
  ).join('');
  const dots = [center, ...nodes].map(n =>
    `<circle class="node ${n.klass}" cx="${n.x}" cy="${n.y}" r="${n.size}" />`
  ).join('');
  const labels = [center, ...nodes].map(n => {
    const dy = n === center ? -16 : (n.y < cy ? -10 : 18);
    return `<text class="node-label" x="${n.x}" y="${n.y + dy}" text-anchor="middle">${escapeHtml(n.label)}</text>`;
  }).join('');
  return `<div class="dig-graph"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">${edges}${dots}${labels}</svg></div>`;
}

function shortDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url.slice(0, 20); }
}

function renderDigPreview(session) {
  const p = session.preview || {};
  const overview = p.ai_overview
    ? `<div class="dig-preview-overview"><div class="dig-preview-tag">AI overview (検索結果より)</div>${escapeHtml(p.ai_overview)}</div>`
    : '';
  const results = (p.results || []).map((r, i) => `
    <li class="dig-preview-result">
      <div class="title"><a href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer">${escapeHtml(r.title || r.url)}</a></div>
      <div class="url">${escapeHtml(r.domain || r.url)}</div>
      <div class="snippet">${escapeHtml(r.snippet || '')}</div>
    </li>
  `).join('');
  if (!overview && !results) return '';
  return `
    <div class="dig-preview">
      <h3 class="dig-preview-h">⚡ クイックプレビュー</h3>
      ${overview}
      <ol class="dig-preview-list">${results}</ol>
    </div>
  `;
}

async function addDigToDictionary(session) {
  if (!session) return;
  const term = (session.query || '').trim();
  if (!term) return;
  const r = session.result || {};
  const definition = r.summary || '';
  try {
    const res = await api('/api/dictionary/upsert-from-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        term,
        source_kind: 'dig',
        source_id: session.id,
        definition,
      }),
    });
    flashToast(res.existed ? `「${term}」にディグをリンクしました` : `「${term}」を辞書に追加しました`);
  } catch (e) {
    alert(`辞書追加失敗: ${e.message}`);
  }
}

// ── Word cloud ─────────────────────────────────────────────────────────

async function startCloudFromBookmarks() {
  const cat = state.category;
  if (!confirm(`${cat ? `カテゴリ「${cat}」の` : '全'}ブックマークからワードクラウドを生成します。\nclaude による解析に数十秒〜数分かかります。よろしいですか？`)) return;
  await startCloud({ origin: 'bookmarks', category: cat });
}

async function startCloudFromDig(digId, parentCloudId, parentWord) {
  await startCloud({ origin: 'dig', digId, parentCloudId, parentWord });
}

async function startCloud(payload) {
  try {
    const r = await api('/api/wordcloud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    state.cloud = { id: r.id, status: 'pending', label: payload.category || payload.digId || '', result: null };
    renderCloud();
    pollCloud(r.id);
  } catch (e) {
    alert(`ワードクラウド生成失敗: ${e.message}`);
  }
}

function pollCloud(id) {
  if (state.cloudPolling) clearInterval(state.cloudPolling);
  loadCloud(id);
  state.cloudPolling = setInterval(async () => {
    const c = await api(`/api/wordcloud/${id}`).catch(() => null);
    if (!c) return;
    if (c.status !== 'pending') {
      clearInterval(state.cloudPolling);
      state.cloudPolling = null;
      state.cloud = c;
      renderCloud();
    }
  }, 5000);
}

async function loadCloud(id) {
  try {
    const c = await api(`/api/wordcloud/${id}`);
    state.cloud = c;
    renderCloud();
    if (c.status === 'pending') pollCloud(id);
    if (c.status === 'done') loadCloudSiblings(id);
  } catch (e) { console.error(e); }
}

async function loadCloudSiblings(id) {
  try {
    const [sibs, graph] = await Promise.all([
      api(`/api/wordcloud/${id}/siblings`),
      api(`/api/wordcloud/${id}/graph?radius=3`),
    ]);
    state.cloudSiblings = sibs.items || [];
    state.cloudGraph = graph;
    renderCloud();
  } catch (e) { console.error(e); }
}

async function mergeWithSiblings() {
  const c = state.cloud;
  if (!c) return;
  const sibs = state.cloudSiblings || [];
  if (sibs.length === 0) return alert('合体できる兄弟雲がありません');
  const ids = [c.id, ...sibs.map(s => s.id)];
  try {
    const r = await api('/api/wordcloud/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloudIds: ids }),
    });
    await loadCloud(r.id);
  } catch (e) {
    alert(`合体失敗: ${e.message}`);
  }
}

function renderCloud() {
  const el = $('cloudView');
  const c = state.cloud;
  if (!c) { el.innerHTML = ''; return; }
  if (c.status === 'pending') {
    el.innerHTML = `<div class="dig-pending"><div class="pulse"></div>ワードクラウドを抽出中…「${escapeHtml(c.label || '')}」</div>`;
    return;
  }
  if (c.status === 'error') {
    el.innerHTML = `<div class="dig-pending" style="border-color:var(--danger);color:var(--danger)">クラウド失敗: ${escapeHtml(c.error || '不明')}</div>`;
    return;
  }
  const r = c.result || {};
  const allWords = r.words || [];
  const kept = allWords.filter(w => w.kept);
  const dropped = allWords.filter(w => !w.kept);
  const display = state.cloudShowDropped ? allWords : kept;

  const summaryBlock = r.summary ? `<div class="summary">${escapeHtml(r.summary)}</div>` : '';
  const breadcrumbBits = [];
  if (c.parent_cloud_id) breadcrumbBits.push(`<span class="parent-link" data-pid="${c.parent_cloud_id}">⬆ 親の雲</span>`);
  if (c.parent_word) breadcrumbBits.push(`<span class="parent-word">→ "${escapeHtml(c.parent_word)}"</span>`);
  const breadcrumb = breadcrumbBits.length ? `<div class="cloud-breadcrumb">${breadcrumbBits.join(' ')}</div>` : '';

  const cloudHtml = renderCloudWords(display);

  const dropToggle = dropped.length > 0
    ? `<label class="check-inline cloud-dropped-toggle"><input type="checkbox" id="cloudShowDropped" ${state.cloudShowDropped ? 'checked' : ''}/> 関係薄を表示 (${dropped.length})</label>`
    : '';

  const dictToggle = `<label class="check-inline cloud-dict-toggle"><input type="checkbox" id="cloudDictMode" ${state.cloudDictMode ? 'checked' : ''}/>📖 辞書登録モード</label>`;

  const sibs = state.cloudSiblings || [];
  const siblingBtn = sibs.length > 0
    ? `<button id="cloudMergeBtn" class="ghost" title="親 ${escapeHtml(c.parent_word || '')} の兄弟雲 ${sibs.length} 件と合体">🔀 兄弟雲をまとめる (${sibs.length})</button>`
    : '';
  const mergedFrom = (r.merged_from || []).length > 0
    ? `<div class="cloud-merged-list">合体元: ${r.merged_from.map(m => `<span class="pill" data-mid="${m.id}">${escapeHtml(m.label)}</span>`).join(' ')}</div>`
    : '';

  const modeHint = state.cloudDictMode
    ? '語クリックで <strong>辞書に登録</strong>'
    : '語クリックで深掘り';

  const graphSvg = renderCloudGraph(state.cloudGraph, c.id);
  const relatedPagesBlock = renderRelatedPages(c.related_pages || []);

  el.innerHTML = `
    <div class="cloud-head">
      <h3>ワードクラウド: ${escapeHtml(c.label || '')}</h3>
      ${breadcrumb}
    </div>

    <section class="cloud-section">
      <h4 class="cloud-section-h">要約</h4>
      ${summaryBlock || '<div class="queue-empty">要約なし</div>'}
      ${mergedFrom}
    </section>

    <section class="cloud-section">
      <h4 class="cloud-section-h">関連ページ</h4>
      ${relatedPagesBlock}
    </section>

    <section class="cloud-section">
      <h4 class="cloud-section-h">グラフ</h4>
      ${graphSvg || '<div class="queue-empty">関連クラウドなし (このクラウドを起点に深掘りしてください)</div>'}
    </section>

    <section class="cloud-section">
      <h4 class="cloud-section-h">タグクラウド</h4>
      <div class="cloud-toolbar">
        ${dropToggle}
        ${dictToggle}
        ${siblingBtn}
        <span class="grow"></span>
        <span style="font-size:11px;color:var(--muted)">${modeHint}</span>
      </div>
      <div class="cloud-words">${cloudHtml}</div>
      <div class="cloud-manual">
        <input id="cloudManualInput" type="text" placeholder="自分でワードを入れて掘る (claude が関連性をチェック)" />
        <button id="cloudManualBtn">関連チェックして掘る</button>
      </div>
    </section>
  `;

  el.querySelector('.parent-link')?.addEventListener('click', () => {
    loadCloud(Number(el.querySelector('.parent-link').dataset.pid));
  });
  el.querySelector('#cloudShowDropped')?.addEventListener('change', (e) => {
    state.cloudShowDropped = e.target.checked;
    renderCloud();
  });
  el.querySelector('#cloudDictMode')?.addEventListener('change', (e) => {
    state.cloudDictMode = e.target.checked;
    renderCloud();
  });
  el.querySelector('#cloudMergeBtn')?.addEventListener('click', mergeWithSiblings);
  el.querySelectorAll('.cloud-merged-list .pill').forEach(p => {
    p.addEventListener('click', () => loadCloud(Number(p.dataset.mid)));
  });
  el.querySelectorAll('.cg-node').forEach(g => {
    g.addEventListener('click', () => {
      const nid = Number(g.dataset.id);
      if (nid && nid !== c.id) loadCloud(nid);
    });
  });
  el.querySelectorAll('.cloud-word').forEach(w => {
    w.addEventListener('click', () => onCloudWordClick(w.dataset.word));
  });
  el.querySelector('#cloudManualBtn')?.addEventListener('click', submitManualWord);
  el.querySelector('#cloudManualInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitManualWord(); }
  });
}

function renderRelatedPages(pages) {
  if (!pages.length) return '<div class="queue-empty">関連ページなし</div>';
  return `<ul class="cloud-related">${pages.map(p => `
    <li class="cloud-related-item">
      <a href="${escapeHtml(p.url)}" target="_blank" rel="noreferrer" class="title">${escapeHtml(p.title)}</a>
      <div class="url">${escapeHtml(p.url)}</div>
      ${p.snippet ? `<div class="snippet">${escapeHtml(p.snippet)}</div>` : ''}
    </li>
  `).join('')}</ul>`;
}

function renderCloudGraph(graph, currentId) {
  if (!graph || !graph.nodes || graph.nodes.length === 0) return '';

  // Group nodes by depth from current. depth=0 sits at the center.
  const byDepth = new Map();
  for (const n of graph.nodes) {
    if (!byDepth.has(n.depth)) byDepth.set(n.depth, []);
    byDepth.get(n.depth).push(n);
  }

  const w = 760, h = 460;
  const cx = w / 2, cy = h / 2;
  const radii = [0, 110, 200, 280];

  const positions = new Map(); // id -> {x,y,size,node}
  // Depth 0 (current) at the center.
  for (const n of (byDepth.get(0) || [])) {
    positions.set(n.id, { x: cx, y: cy, node: n });
  }
  for (let d = 1; d <= 3; d++) {
    const list = byDepth.get(d) || [];
    list.forEach((n, i) => {
      // Spread around the circle, with a slight angular offset per ring
      const a = (i / Math.max(list.length, 1)) * Math.PI * 2 - Math.PI / 2 + (d * 0.18);
      const x = cx + Math.cos(a) * radii[d];
      const y = cy + Math.sin(a) * radii[d];
      positions.set(n.id, { x, y, node: n });
    });
  }

  // Node size = bounded by total_weight
  const maxW = Math.max(1, ...graph.nodes.map(n => n.total_weight || 1));
  function nodeRadius(n) {
    const ratio = (n.total_weight || 1) / maxW;
    return n.id === currentId ? 26 + ratio * 14 : 14 + ratio * 14;
  }

  // Edges
  const edgesSvg = (graph.edges || []).map(e => {
    const a = positions.get(e.from), b = positions.get(e.to);
    if (!a || !b) return '';
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const labelTxt = (e.label || '').slice(0, 14);
    return `
      <g class="cg-edge">
        <line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" />
        ${labelTxt ? `<text x="${midX}" y="${midY - 4}" text-anchor="middle">${escapeHtml(labelTxt)}</text>` : ''}
      </g>
    `;
  }).join('');

  // Nodes
  const nodesSvg = graph.nodes.map(n => {
    const p = positions.get(n.id);
    if (!p) return '';
    const r = nodeRadius(n);
    const isCurrent = n.id === currentId;
    const cls = `cg-node depth-${n.depth}${isCurrent ? ' current' : ''}`;
    const top = (n.top_words || []).slice(0, 3).map(w => w.word).join(' / ');
    const labelTxt = (n.label || '').slice(0, 18);
    const truncMark = (n.truncated_children > 0)
      ? `<text class="cg-trunc" x="${p.x}" y="${(p.y + r + 14).toFixed(1)}" text-anchor="middle">…+${n.truncated_children}</text>`
      : '';
    return `
      <g class="${cls}" data-id="${n.id}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">
        <circle r="${r}" />
        <text class="cg-label" y="-${(r + 6).toFixed(1)}" text-anchor="middle">${escapeHtml(labelTxt)}</text>
        <text class="cg-top" y="4" text-anchor="middle">${escapeHtml(top)}</text>
        <title>${escapeHtml(n.label)}\n${escapeHtml(n.summary || '')}\n--\n${(n.top_words||[]).map(w=>`${w.word} (${w.weight})`).join(', ')}</title>
      </g>
      ${truncMark}
    `;
  }).join('');

  return `<div class="cloud-graph"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">${edgesSvg}${nodesSvg}</svg><div class="cloud-graph-hint">クリックで雲を切り替え · 半径 3 階層まで表示 (それより遠い枝は ${'…+N'} で省略)</div></div>`;
}

function renderCloudWords(words) {
  if (!words.length) return '<div class="queue-empty">該当語なし</div>';
  const max = Math.max(1, ...words.map(w => w.weight || 1));
  return words.map(w => {
    const ratio = (w.weight || 1) / max;
    const fontSize = (12 + ratio * 30).toFixed(1);
    const opacity = w.kept ? 1 : 0.45;
    const cls = w.kept ? 'cloud-word' : 'cloud-word dropped';
    const title = w.kept
      ? `weight=${w.weight}, sources=${w.sources}`
      : `関係薄: ${w.reason || '(理由なし)'} — weight=${w.weight}`;
    return `<span class="${cls}" data-word="${escapeHtml(w.word)}" style="font-size:${fontSize}px;opacity:${opacity}" title="${escapeHtml(title)}">${escapeHtml(w.word)}</span>`;
  }).join(' ');
}

async function onCloudWordClick(word) {
  if (!word) return;
  const c = state.cloud;
  if (state.cloudDictMode) {
    await addCloudWordToDictionary(word, c);
    return;
  }
  // Drilling from cloud: words are pre-validated (kept=true). Run a dig with this word as query.
  switchTab('dig');
  $('digQuery').value = word;
  await startDig({ chainCloudId: c?.id, chainParentWord: word });
}

async function addCloudWordToDictionary(word, cloud) {
  if (!cloud) return;
  try {
    const r = await api('/api/dictionary/upsert-from-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        term: word,
        source_kind: 'cloud',
        source_id: cloud.id,
        notes: cloud.label ? `via cloud: ${cloud.label}` : null,
      }),
    });
    flashToast(r.existed ? `「${word}」を既存エントリにリンクしました` : `「${word}」を辞書に追加しました`);
  } catch (e) {
    alert(`辞書登録失敗: ${e.message}`);
  }
}

function flashToast(msg) {
  let el = document.getElementById('memToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'memToast';
    el.className = 'mem-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(flashToast._t);
  flashToast._t = setTimeout(() => el.classList.remove('show'), 2400);
}

async function submitManualWord() {
  const input = $('cloudManualInput');
  const word = (input?.value || '').trim();
  if (!word) return;
  const c = state.cloud;
  const context = c?.result?.summary || c?.label || 'general bookmarks';
  const btn = $('cloudManualBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'チェック中…'; }
  try {
    const v = await api('/api/wordcloud/validate-word', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word, context }),
    });
    if (!v.related) {
      if (!confirm(`「${word}」は関連性が低いと判定されました。\n理由: ${v.reason || '(なし)'}\nそれでも掘りますか？`)) {
        return;
      }
    }
    switchTab('dig');
    $('digQuery').value = word;
    await startDig({ chainCloudId: c?.id, chainParentWord: word });
  } catch (e) {
    alert(`関連チェック失敗: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '関連チェックして掘る'; }
  }
}

// ── Dictionary ─────────────────────────────────────────────────────────

async function loadDictionary() {
  try {
    const q = state.dictSearch ? `?q=${encodeURIComponent(state.dictSearch)}` : '';
    const r = await api(`/api/dictionary${q}`);
    state.dictEntries = r.items || [];
    renderDictionaryList();
  } catch (e) { console.error(e); }
}

function renderDictionaryList() {
  const ul = $('dictList');
  if (!state.dictEntries.length) {
    ul.innerHTML = '<li class="dict-empty">辞書エントリはまだありません。雲の語をクリック (辞書登録モード) や、ディグの「📖 辞書に追加」から登録できます。</li>';
    return;
  }
  ul.innerHTML = state.dictEntries.map(e => `
    <li class="dict-item ${state.dictDetail?.id === e.id ? 'selected' : ''}" data-id="${e.id}">
      <div class="dict-term">${escapeHtml(e.term)}</div>
      <div class="dict-snippet">${escapeHtml((e.definition || e.notes || '').slice(0, 320))}</div>
      <div class="dict-meta">
        <span>${e.link_count} 件リンク</span>
        <span>${fmtDate(e.updated_at)}</span>
      </div>
    </li>
  `).join('');
  ul.querySelectorAll('.dict-item').forEach(li => {
    li.addEventListener('click', () => loadDictionaryEntry(Number(li.dataset.id)));
  });
}

async function loadDictionaryEntry(id) {
  try {
    const e = await api(`/api/dictionary/${id}`);
    state.dictDetail = e;
    renderDictionaryList();
    renderDictionaryDetail();
  } catch (e) { console.error(e); }
}

async function renderDictionaryDetail() {
  const e = state.dictDetail;
  const panel = $('dictDetail');
  if (!e) { hideModal('dictDetail'); return; }
  showModal('dictDetail');
  $('dictTerm').value = e.term || '';
  $('dictDefinition').value = e.definition || '';
  $('dictNotes').value = e.notes || '';

  const links = e.links || [];
  if (!links.length) {
    $('dictLinks').innerHTML = '<li class="dict-empty">リンクなし</li>';
    return;
  }

  // Resolve sources by kind for nicer labels.
  const resolved = await Promise.all(links.map(async l => {
    let label = `${l.source_kind} #${l.source_id}`;
    let url = '';
    try {
      if (l.source_kind === 'cloud') {
        const c = await api(`/api/wordcloud/${l.source_id}`);
        label = `🌐 雲: ${c.label || ''}`;
      } else if (l.source_kind === 'dig') {
        const d = await api(`/api/dig/${l.source_id}`);
        label = `🔎 dig: ${d.query || ''}`;
      } else if (l.source_kind === 'bookmark') {
        const b = await api(`/api/bookmarks/${l.source_id}`);
        label = `📑 ${b.title || ''}`;
        url = b.url || '';
      }
    } catch {}
    return { ...l, label, url };
  }));
  $('dictLinks').innerHTML = resolved.map(l => `
    <li class="dict-link" data-kind="${l.source_kind}" data-sid="${l.source_id}">
      <span class="dict-link-label">${escapeHtml(l.label)}</span>
      ${l.url ? `<a href="${escapeHtml(l.url)}" target="_blank" rel="noreferrer" class="ghost">↗</a>` : ''}
      <button class="ghost dict-link-remove" data-kind="${l.source_kind}" data-sid="${l.source_id}">×</button>
    </li>
  `).join('');
  $('dictLinks').querySelectorAll('.dict-link-label').forEach(s => {
    s.addEventListener('click', () => {
      const li = s.closest('.dict-link');
      const kind = li.dataset.kind;
      const sid = Number(li.dataset.sid);
      navigateToDictSource(kind, sid);
    });
  });
  $('dictLinks').querySelectorAll('.dict-link-remove').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await api(`/api/dictionary/${e.id}/links?source_kind=${btn.dataset.kind}&source_id=${btn.dataset.sid}`, { method: 'DELETE' });
      await loadDictionaryEntry(e.id);
    });
  });
}

function navigateToDictSource(kind, sid) {
  if (kind === 'cloud') {
    switchTab('dig');
    loadCloud(sid);
  } else if (kind === 'dig') {
    switchTab('dig');
    loadDigSession(sid);
  } else if (kind === 'bookmark') {
    switchTab('bookmarks');
    openDetail(sid);
  }
}

async function saveDictionaryEntry() {
  const e = state.dictDetail;
  if (!e) return;
  const body = {
    term: $('dictTerm').value.trim(),
    definition: $('dictDefinition').value,
    notes: $('dictNotes').value,
  };
  if (!body.term) return alert('単語は必須です');
  try {
    await api(`/api/dictionary/${e.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    flashToast('保存しました');
    await loadDictionary();
    await loadDictionaryEntry(e.id);
  } catch (e) {
    alert(`保存失敗: ${e.message}`);
  }
}

async function deleteDictionaryEntry() {
  const e = state.dictDetail;
  if (!e) return;
  if (!confirm(`「${e.term}」を辞書から削除しますか？`)) return;
  try {
    await api(`/api/dictionary/${e.id}`, { method: 'DELETE' });
    state.dictDetail = null;
    hideModal('dictDetail');
    await loadDictionary();
  } catch (e) {
    alert(`削除失敗: ${e.message}`);
  }
}

async function createDictionaryEntry() {
  const term = prompt('新しいエントリの単語を入力してください');
  if (!term || !term.trim()) return;
  try {
    const r = await api('/api/dictionary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: term.trim() }),
    });
    await loadDictionary();
    await loadDictionaryEntry(r.id);
  } catch (e) {
    alert(`作成失敗: ${e.message}`);
  }
}

// ── Domain catalog ─────────────────────────────────────────────────────

async function loadDomainCatalog() {
  try {
    const q = state.domainSearch ? `?q=${encodeURIComponent(state.domainSearch)}` : '';
    const r = await api(`/api/domains${q}`);
    state.domainEntries = r.items || [];
    renderDomainList();
  } catch (e) { console.error(e); }
}

function renderDomainList() {
  const ul = $('domainList');
  if (!state.domainEntries.length) {
    ul.innerHTML = '<li class="dict-empty">ドメイン辞書はまだ空です。アクセス履歴の生成によって自動で追加されます。</li>';
    return;
  }
  ul.innerHTML = state.domainEntries.map(e => {
    const desc = (e.description || '').trim();
    const can = (e.can_do || '').trim();
    const body = desc + (desc && can ? '\n\n' : '') + (can ? `できること:\n${can}` : '');
    return `
    <li class="dict-item ${state.domainDetail?.domain === e.domain ? 'selected' : ''}" data-domain="${escapeHtml(e.domain)}">
      <div class="dict-term">${escapeHtml(e.site_name || e.domain)}</div>
      <div class="dict-snippet">${escapeHtml(body.slice(0, 320))}</div>
      <div class="dict-meta">
        <span>${escapeHtml(e.domain)}</span>
        <span>本日 ${e.visits_today} / 週 ${e.visits_week}</span>
      </div>
    </li>`;
  }).join('');
  ul.querySelectorAll('.dict-item').forEach(li => {
    li.addEventListener('click', () => loadDomainEntry(li.dataset.domain));
  });
}

async function loadDomainEntry(domain) {
  try {
    const e = await api(`/api/domains/${encodeURIComponent(domain)}`);
    // Visit counts from list (re-use the cached row).
    const fromList = state.domainEntries.find(x => x.domain === domain) || {};
    state.domainDetail = { ...e, visits_today: fromList.visits_today, visits_week: fromList.visits_week, visits_total: fromList.visits_total };
    renderDomainList();
    renderDomainDetail();
  } catch (e) { console.error(e); }
}

function renderDomainDetail() {
  const e = state.domainDetail;
  const panel = $('domainDetail');
  if (!e) { hideModal('domainDetail'); return; }
  showModal('domainDetail');
  $('domainKey').value = e.domain;
  $('domainSiteName').value = e.site_name || '';
  $('domainDesc').value = e.description || '';
  $('domainCanDo').value = e.can_do || '';
  $('domainKind').value = e.kind || '';
  $('domainNotes').value = e.notes || '';
  $('domainStats').innerHTML = `
    <span class="domain-stat"><b>${e.visits_today ?? 0}</b><br>本日</span>
    <span class="domain-stat"><b>${e.visits_week ?? 0}</b><br>過去7日</span>
    <span class="domain-stat"><b>${e.visits_total ?? 0}</b><br>累計</span>
    <span class="domain-stat"><b>${e.user_edited ? '✓' : '—'}</b><br>編集済み</span>
    <span class="domain-stat"><b>${e.status}</b><br>状態</span>
  `;
}

async function saveDomainEntry() {
  const e = state.domainDetail;
  if (!e) return;
  try {
    await api(`/api/domains/${encodeURIComponent(e.domain)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site_name: $('domainSiteName').value,
        description: $('domainDesc').value,
        can_do: $('domainCanDo').value,
        kind: $('domainKind').value,
        notes: $('domainNotes').value,
      }),
    });
    flashToast('ドメイン情報を保存しました');
    await loadDomainCatalog();
    await loadDomainEntry(e.domain);
  } catch (err) {
    alert(`保存失敗: ${err.message}`);
  }
}

async function regenerateDomainEntry() {
  const e = state.domainDetail;
  if (!e) return;
  try {
    await api(`/api/domains/${encodeURIComponent(e.domain)}/regenerate`, { method: 'POST' });
    flashToast('再分類をキューに投入しました (user_edited 列は保護されます)');
  } catch (err) {
    alert(`失敗: ${err.message}`);
  }
}

async function deleteDomainEntry() {
  const e = state.domainDetail;
  if (!e) return;
  if (!confirm(`「${e.domain}」をドメイン辞書から削除しますか？`)) return;
  await api(`/api/domains/${encodeURIComponent(e.domain)}`, { method: 'DELETE' });
  state.domainDetail = null;
  hideModal('domainDetail');
  await loadDomainCatalog();
}

async function recatalogAllDomains({ force = false } = {}) {
  const note = force
    ? 'force 再分類: 既存ドメインも含めて全部再分類します (user_edited 列は保護)。LLM コストが高くつく可能性があります。実行しますか？'
    : 'アクセス記録に出てきたドメインのうち、まだ辞書に無いものを分類キューに積みます。実行しますか？';
  if (!confirm(note)) return;
  const status = $('recatalogAllStatus');
  if (status) {
    status.textContent = '走査中...';
    status.classList.remove('error');
  }
  try {
    const r = await api('/api/domains/recatalog-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    });
    const msg = `走査 URL ${r.scanned_urls}、ユニークドメイン ${r.unique_domains}、`
              + `キュー追加 ${r.queued}、既存スキップ ${r.skipped_existing}、`
              + `host スキップ ${r.skipped_host}、キュー深さ ${r.queue_depth}`;
    flashToast(msg);
    if (status) {
      status.textContent = msg;
      status.classList.remove('error');
    }
    await loadDomainCatalog();
  } catch (e) {
    const msg = `失敗: ${e.message}`;
    alert(msg);
    if (status) {
      status.textContent = msg;
      status.classList.add('error');
    }
  }
}

// ── Diary ──────────────────────────────────────────────────────────────

function todayLocalDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(monthStr, delta) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function loadDiary() {
  if (!state.diaryMonth) state.diaryMonth = todayMonth();
  await refreshDiaryMonth();
}

async function refreshDiaryMonth() {
  try {
    const [diary, weekly] = await Promise.all([
      api(`/api/diary?month=${encodeURIComponent(state.diaryMonth)}`),
      api(`/api/weekly?month=${encodeURIComponent(state.diaryMonth)}`),
    ]);
    state.diaryEntries = diary.items || [];
    state.weeklyEntries = weekly.items || [];
    renderDiaryCalendar(diary);
    renderWeeklyList();
  } catch (e) {
    console.error('diary load failed', e);
  }
}

function renderWeeklyList() {
  const ul = $('diaryWeekList');
  if (!ul) return;
  const items = state.weeklyEntries || [];
  // Always also list potential weeks for the month (so user can hit "作成"
  // for weeks that aren't generated yet). Compute Mondays within this month.
  const [y, m] = state.diaryMonth.split('-').map(Number);
  const monthEnd = new Date(y, m, 0).getDate();
  const generated = new Map(items.map(w => [w.week_start, w]));
  const candidates = [];
  for (let d = 1; d <= monthEnd; d++) {
    const dt = new Date(y, m - 1, d);
    if (dt.getDay() !== 1) continue; // Mondays only
    const ws = `${state.diaryMonth}-${String(d).padStart(2, '0')}`;
    candidates.push(ws);
  }
  // Also include weeks whose Monday is in the previous month but Sunday is in this month.
  const firstOfMonth = new Date(y, m - 1, 1);
  if (firstOfMonth.getDay() !== 1) {
    const offset = firstOfMonth.getDay() === 0 ? -6 : 1 - firstOfMonth.getDay();
    const monBefore = new Date(firstOfMonth);
    monBefore.setDate(firstOfMonth.getDate() + offset);
    const ws = `${monBefore.getFullYear()}-${String(monBefore.getMonth() + 1).padStart(2, '0')}-${String(monBefore.getDate()).padStart(2, '0')}`;
    candidates.unshift(ws);
  }
  if (!candidates.length) {
    ul.innerHTML = '<li class="queue-empty">この月に該当する週なし</li>';
    return;
  }
  const today = todayLocalDate();
  ul.innerHTML = candidates.map((ws, idx) => {
    const w = generated.get(ws);
    const sunday = new Date(ws + 'T00:00:00');
    sunday.setDate(sunday.getDate() + 6);
    const sundayStr = `${String(sunday.getMonth() + 1).padStart(2, '0')}/${String(sunday.getDate()).padStart(2, '0')}`;
    const monStr = ws.slice(5).replace('-', '/');
    const label = `${y}年${m}月 第${idx + 1}週 (${monStr}〜${sundayStr})`;
    const status = w?.status || 'absent';
    const future = ws > today;
    const klass = `diary-week-item status-${status}${future ? ' future' : ''}`;
    const tag = w?.status === 'done' ? '✓' : w?.status === 'pending' ? '…' : w?.status === 'error' ? '!' : '+';
    return `<li class="${klass}" data-week="${ws}">
      <span class="diary-week-tag">${tag}</span>
      <span class="diary-week-label">${escapeHtml(label)}</span>
    </li>`;
  }).join('');
  ul.querySelectorAll('.diary-week-item').forEach(li => {
    li.addEventListener('click', () => loadWeekly(li.dataset.week));
  });
}

async function loadWeekly(weekStart) {
  state.weeklyDetailWeek = weekStart;
  $('diaryDetail').classList.add('hidden');
  $('weeklyDetail').classList.remove('hidden');
  try {
    const w = await api(`/api/weekly/${weekStart}`);
    state.weeklyDetail = w;
    renderWeeklyDetail();
    if (w.status === 'pending') pollWeekly(weekStart);
  } catch (e) {
    alert(`週報取得失敗: ${e.message}`);
  }
}

function pollWeekly(ws) {
  if (state.weeklyPolling) clearInterval(state.weeklyPolling);
  state.weeklyPolling = setInterval(async () => {
    if (state.weeklyDetailWeek !== ws) {
      clearInterval(state.weeklyPolling); state.weeklyPolling = null; return;
    }
    const w = await api(`/api/weekly/${ws}`).catch(() => null);
    if (!w) return;
    if (w.status !== 'pending') {
      clearInterval(state.weeklyPolling); state.weeklyPolling = null;
      state.weeklyDetail = w;
      renderWeeklyDetail();
      refreshDiaryMonth();
    }
  }, 5000);
}

function renderWeeklyDetail() {
  const w = state.weeklyDetail;
  if (!w) return;
  $('weeklyTitle').textContent = `${w.week_start} 〜 ${w.week_end}`;
  const status = w.status || 'absent';
  const statusEl = $('weeklyStatus');
  const labels = { absent: '未作成', pending: '生成中…', done: '完了', error: 'エラー' };
  statusEl.textContent = labels[status] || status;
  statusEl.className = `diary-status-tag status-${status}`;
  const btn = $('weeklyGenerate');
  btn.textContent = status === 'absent' ? '作成' : '再生成';
  btn.disabled = status === 'pending';

  if (status === 'absent') {
    $('weeklySummary').innerHTML = '<div class="queue-empty">この週の週報はまだ作成されていません。「作成」ボタンを押して生成できます。</div>';
  } else if (status === 'pending') {
    $('weeklySummary').innerHTML = '<div class="dig-pending"><div class="pulse"></div>Opus 1M が週報を生成中…</div>';
  } else if (status === 'error') {
    $('weeklySummary').innerHTML = `<div class="dig-pending" style="border-color:var(--danger);color:var(--danger)">エラー: ${escapeHtml(w.error || '不明')}</div>`;
  } else {
    $('weeklySummary').textContent = w.summary || '';
  }

  const ghRepos = w.github_summary?.repos || [];
  $('weeklyGithub').innerHTML = ghRepos.length === 0
    ? '<li class="queue-empty">commit なし</li>'
    : ghRepos.map(r =>
      `<li><span class="diary-gh-repo">${escapeHtml(r.repo)}</span><span class="diary-gh-count">${r.count} commits</span></li>`
    ).join('');
}

async function generateWeekly() {
  const ws = state.weeklyDetailWeek;
  if (!ws) return;
  const btn = $('weeklyGenerate');
  btn.disabled = true;
  btn.textContent = '投入中…';
  try {
    await api(`/api/weekly/${ws}/generate`, { method: 'POST' });
    flashToast(`${ws} の週報を生成キューに投入しました`);
    await loadWeekly(ws);
  } catch (e) {
    alert(`失敗: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '再生成';
  }
}

async function deleteWeeklyEntry() {
  const ws = state.weeklyDetailWeek;
  if (!ws) return;
  if (!confirm(`${ws} の週報を削除しますか？`)) return;
  await api(`/api/weekly/${ws}`, { method: 'DELETE' });
  state.weeklyDetail = null;
  state.weeklyDetailWeek = null;
  $('weeklyDetail').classList.add('hidden');
  refreshDiaryMonth();
}

function renderDiaryCalendar({ month, start, end }) {
  $('diaryMonthLabel').textContent = month;
  const [y, m] = month.split('-').map(Number);
  const firstWeekday = new Date(y, m - 1, 1).getDay();
  const lastDay = new Date(y, m, 0).getDate();
  const today = todayLocalDate();
  const byDate = new Map(state.diaryEntries.map(e => [e.date, e]));

  let html = '';
  // Leading blanks
  for (let i = 0; i < firstWeekday; i++) {
    html += `<div class="diary-cell empty"></div>`;
  }
  for (let d = 1; d <= lastDay; d++) {
    const ds = `${month}-${String(d).padStart(2, '0')}`;
    const entry = byDate.get(ds);
    const klass = [
      'diary-cell',
      entry ? `has-${entry.status || 'pending'}` : '',
      ds === today ? 'today' : '',
      ds > today ? 'future' : '',
      state.diaryDetailDate === ds ? 'selected' : '',
    ].filter(Boolean).join(' ');
    const indicator = entry?.status === 'done' ? '✓' : entry?.status === 'pending' ? '…' : entry?.status === 'error' ? '!' : '';
    html += `
      <div class="${klass}" data-date="${ds}">
        <div class="diary-cell-day">${d}</div>
        <div class="diary-cell-mark">${indicator}</div>
      </div>
    `;
  }
  $('diaryCalendar').innerHTML = html;
  $('diaryCalendar').querySelectorAll('.diary-cell[data-date]').forEach(cell => {
    cell.addEventListener('click', () => loadDiaryDetail(cell.dataset.date));
  });
}

async function loadDiaryDetail(date) {
  state.diaryDetailDate = date;
  state.weeklyDetailWeek = null;
  $('weeklyDetail').classList.add('hidden');
  $('diaryDetail').classList.remove('hidden');
  try {
    const d = await api(`/api/diary/${date}`);
    state.diaryDetail = d;
    renderDiaryDetail();
    if (d.status === 'pending') pollDiary(date);
    refreshDiaryMonth();
  } catch (e) {
    alert(`日記取得失敗: ${e.message}`);
  }
}

function pollDiary(date) {
  if (state.diaryPolling) clearInterval(state.diaryPolling);
  state.diaryPolling = setInterval(async () => {
    if (state.diaryDetailDate !== date) {
      clearInterval(state.diaryPolling); state.diaryPolling = null; return;
    }
    const d = await api(`/api/diary/${date}`).catch(() => null);
    if (!d) return;
    if (d.status !== 'pending') {
      clearInterval(state.diaryPolling); state.diaryPolling = null;
      state.diaryDetail = d;
      renderDiaryDetail();
      refreshDiaryMonth();
    }
  }, 3000);
}

function renderDiaryDetail() {
  const d = state.diaryDetail;
  if (!d) return;
  $('diaryDate').textContent = d.date;
  const status = d.status || 'absent';
  const statusEl = $('diaryStatus');
  const statusLabels = { absent: '未作成', pending: '生成中…', done: '完了', error: 'エラー' };
  statusEl.textContent = statusLabels[status] || status;
  statusEl.className = `diary-status-tag status-${status}`;

  const generateBtn = $('diaryGenerate');
  generateBtn.textContent = (status === 'absent') ? '作成' : '再生成';
  generateBtn.disabled = (status === 'pending');

  if (status === 'absent') {
    $('diaryWork').innerHTML = '<div class="queue-empty">この日の日記はまだ作成されていません。「作成」ボタンを押して生成できます。</div>';
    $('diaryHighlights').innerHTML = '';
  } else if (status === 'pending') {
    $('diaryWork').innerHTML = '<div class="dig-pending"><div class="pulse"></div>Sonnet が作業内容を解析中…</div>';
    $('diaryHighlights').innerHTML = '<div class="dig-pending"><div class="pulse"></div>Opus 1M がハイライトを生成中…</div>';
  } else if (status === 'error') {
    $('diaryWork').innerHTML = `<div class="dig-pending" style="border-color:var(--danger);color:var(--danger)">エラー: ${escapeHtml(d.error || '不明')}</div>`;
    $('diaryHighlights').innerHTML = '';
  } else {
    $('diaryWork').textContent = d.work_content || '(なし)';
    $('diaryHighlights').textContent = d.highlights || '(なし)';
  }

  // Hourly chart: live_metrics is computed fresh on every request and includes
  // page_visits as a fallback for events captured before visit_events existed,
  // so it's preferred over the snapshot stored at generation time.
  const metrics = d.live_metrics || d.metrics || { hourly_visits: new Array(24).fill(0), top_domains: [] };
  $('diaryHourly').innerHTML = renderHourlyChart(metrics.hourly_visits || []);
  const domains = metrics.top_domains || [];
  $('diaryPie').innerHTML = renderDomainPie(domains);
  $('diaryDomains').innerHTML = domains.length === 0
    ? '<li class="queue-empty">アクセスログなし</li>'
    : domains.slice(0, 12).map((dm, i) => {
      const color = pieColor(i);
      const display = dm.site_name || dm.domain;
      const sub = dm.site_name && dm.site_name !== dm.domain
        ? `<span class="diary-domain-sub">${escapeHtml(dm.domain)}</span>`
        : '';
      const desc = dm.description
        ? `<div class="diary-domain-desc">${dm.kind ? `<span class="visits-kind">${escapeHtml(dm.kind)}</span> ` : ''}${escapeHtml(dm.description)}</div>`
        : '';
      return `<li>
        <div class="diary-domain-row"><span class="diary-domain-swatch" style="background:${color}"></span><span class="diary-domain-name">${escapeHtml(display)}</span>${sub}<span class="diary-domain-count">${dm.count} 件 · ${dm.active_hours.length} 時間帯</span></div>
        ${desc}
      </li>`;
    }).join('');

  const created = metrics.bookmarks?.created || [];
  $('diaryBookmarksCreated').innerHTML = created.length === 0
    ? '<li class="queue-empty">新規ブックマークなし</li>'
    : created.map(b =>
      `<li class="diary-bookmark" data-id="${b.id}">
        <a href="${escapeHtml(b.url)}" target="_blank" rel="noreferrer" class="title">${escapeHtml(b.title)}</a>
        <div class="url">${escapeHtml(b.url)}</div>
        ${b.summary ? `<div class="summary">${escapeHtml(b.summary.slice(0, 200))}</div>` : ''}
      </li>`
    ).join('');
  const accessed = metrics.bookmarks?.accessed || [];
  $('diaryBookmarksAccessed').innerHTML = accessed.length === 0
    ? '<li class="queue-empty">再訪なし</li>'
    : accessed.map(b =>
      `<li class="diary-bookmark" data-id="${b.id}">
        <a href="${escapeHtml(b.url)}" target="_blank" rel="noreferrer" class="title">${escapeHtml(b.title)}</a>
        <div class="url">${escapeHtml(b.url)} <span class="access-count">×${b.access_count}</span></div>
      </li>`
    ).join('');
  document.querySelectorAll('.diary-bookmark').forEach(li => {
    li.addEventListener('click', (ev) => {
      if (ev.target.tagName === 'A') return;
      const id = Number(li.dataset.id);
      switchTab('bookmarks');
      openDetail(id);
    });
  });

  const digs = metrics.digs || [];
  if (digs.length === 0) {
    $('diaryDigs').innerHTML = '<li class="queue-empty">この日のディグはなし</li>';
  } else {
    $('diaryDigs').innerHTML = digs.map(dg => `
      <li class="diary-dig" data-id="${dg.id}">
        <div class="diary-dig-head">
          <span class="diary-dig-query">${escapeHtml(dg.query)}</span>
          <span class="diary-dig-meta">${dg.source_count} 件 · ${escapeHtml(dg.status)}</span>
        </div>
        ${dg.summary ? `<div class="diary-dig-summary">${escapeHtml(dg.summary)}</div>` : ''}
      </li>
    `).join('');
    $('diaryDigs').querySelectorAll('.diary-dig').forEach(li => {
      li.addEventListener('click', () => {
        const id = Number(li.dataset.id);
        switchTab('dig');
        loadDigSession(id);
      });
    });
  }

  const commits = d.github_commits?.commits || [];
  if (commits.length === 0) {
    $('diaryGithub').innerHTML = `<li class="queue-empty">${d.github_commits?.error ? escapeHtml('GitHub: ' + d.github_commits.error) : 'commit 記録なし'}</li>`;
  } else {
    // Group by repo: { repo: count }
    const byRepo = new Map();
    for (const c of commits) {
      byRepo.set(c.repo, (byRepo.get(c.repo) || 0) + 1);
    }
    const rows = [...byRepo.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([repo, n]) => `<li><span class="diary-gh-repo">${escapeHtml(repo)}</span><span class="diary-gh-count">${n} commits</span></li>`)
      .join('');
    $('diaryGithub').innerHTML = rows;
  }

  $('diaryNotes').value = d.notes || '';
}

const PIE_PALETTE = [
  '#1f56c0', '#3a7ddc', '#7aa3df', '#c5cad4',
  '#e07b00', '#f0a040', '#9c27b0', '#ce93d8',
  '#388e3c', '#81c784', '#d04545', '#f5a8a8',
];
function pieColor(i) { return PIE_PALETTE[i % PIE_PALETTE.length]; }

function renderDomainPie(domains) {
  if (!domains.length) return '<div class="queue-empty">データなし</div>';
  const top = domains.slice(0, 12);
  // Aggregate the long tail into "その他"
  const tail = domains.slice(12).reduce((s, d) => s + d.count, 0);
  const slices = tail > 0 ? [...top, { domain: 'その他', count: tail }] : top;
  const total = slices.reduce((s, d) => s + d.count, 0);
  if (total <= 0) return '<div class="queue-empty">データなし</div>';

  const cx = 110, cy = 110, r = 90;
  let startAngle = -Math.PI / 2;
  let paths = '';
  slices.forEach((d, i) => {
    const portion = d.count / total;
    const sweep = portion * Math.PI * 2;
    const endAngle = startAngle + sweep;
    const color = d.domain === 'その他' ? '#bbb' : pieColor(i);
    const x1 = cx + Math.cos(startAngle) * r;
    const y1 = cy + Math.sin(startAngle) * r;
    const x2 = cx + Math.cos(endAngle) * r;
    const y2 = cy + Math.sin(endAngle) * r;
    const large = sweep > Math.PI ? 1 : 0;
    if (slices.length === 1) {
      paths += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" />
        <title>${escapeHtml(d.domain)}: 100%</title>`;
    } else {
      const path = `M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z`;
      const labelAngle = startAngle + sweep / 2;
      const lx = cx + Math.cos(labelAngle) * (r * 0.65);
      const ly = cy + Math.sin(labelAngle) * (r * 0.65);
      const pct = (portion * 100).toFixed(1);
      const showLabel = portion >= 0.06;
      paths += `<g class="pie-slice"><path d="${path}" fill="${color}" />
        ${showLabel ? `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" dy="3" class="pie-label">${pct}%</text>` : ''}
        <title>${escapeHtml(d.domain)}: ${d.count} 件 (${pct}%)</title></g>`;
    }
    startAngle = endAngle;
  });
  return `<svg viewBox="0 0 220 220" preserveAspectRatio="xMidYMid meet">${paths}</svg>`;
}

function renderHourlyChart(hours) {
  const max = Math.max(1, ...hours);
  const w = 720, h = 140, padL = 30, padR = 12, padT = 12, padB = 24;
  const cw = (w - padL - padR) / 24;
  let bars = '';
  for (let i = 0; i < 24; i++) {
    const v = hours[i] || 0;
    const bh = Math.round((v / max) * (h - padT - padB));
    const x = padL + i * cw;
    const y = h - padB - bh;
    bars += `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(cw - 2).toFixed(1)}" height="${bh}" class="diary-bar" />
      <text x="${(x + cw / 2).toFixed(1)}" y="${(h - padB + 12).toFixed(1)}" class="diary-bar-label">${i}</text>
      ${v > 0 ? `<text x="${(x + cw / 2).toFixed(1)}" y="${(y - 2).toFixed(1)}" class="diary-bar-value">${v}</text>` : ''}
    `;
  }
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">${bars}</svg>`;
}

async function generateDiary({ improve = '' } = {}) {
  const date = state.diaryDetailDate;
  if (!date) return;
  const btn = improve ? $('diaryImproveBtn') : $('diaryGenerate');
  const baseLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '投入中…';
  const status = $('diaryImproveStatus');
  if (improve && status) { status.textContent = ''; }
  try {
    await api(`/api/diary/${date}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ improve }),
    });
    flashToast(`${date} の日記を生成キューに投入しました${improve ? ' (改善指示込み)' : ''}`);
    if (improve) {
      // One-shot — clear the textarea so the next click is a fresh prompt.
      $('diaryImproveInput').value = '';
      if (status) status.textContent = '✓ 投入しました';
    }
    await loadDiaryDetail(date);
  } catch (e) {
    if (improve && status) status.textContent = `✗ ${e.message}`;
    else alert(`失敗: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = baseLabel;
  }
}

async function improveDiary() {
  const text = ($('diaryImproveInput')?.value || '').trim();
  if (!text) {
    alert('改善したい内容を書いてから押してください。');
    return;
  }
  await generateDiary({ improve: text });
}

async function deleteDiaryEntry() {
  const date = state.diaryDetailDate;
  if (!date) return;
  if (!confirm(`${date} の日記を削除しますか？ (アクセスログ自体は消えません)`)) return;
  await api(`/api/diary/${date}`, { method: 'DELETE' });
  state.diaryDetail = null;
  state.diaryDetailDate = null;
  $('diaryDetail').classList.add('hidden');
  refreshDiaryMonth();
}

async function saveDiaryNotes() {
  const date = state.diaryDetailDate;
  if (!date) return;
  const notes = $('diaryNotes').value;
  try {
    await api(`/api/diary/${date}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    });
    flashToast('メモを保存しました');
  } catch (e) {
    alert(`保存失敗: ${e.message}`);
  }
}

async function openDiarySettings() {
  $('diarySettingsPanel').classList.remove('hidden');
  try {
    const s = await api('/api/diary/settings');
    $('diaryGhUser').value = s.github_user || '';
    $('diaryGhRepos').value = s.github_repos || '';
    $('diaryGhTokenStatus').textContent = s.github_token_set ? '✓ token 設定済み (再入力で上書き)' : '(未設定)';
  } catch (e) { console.error(e); }
}

async function testGithubPat() {
  const el = $('diaryGhTestResult');
  el.textContent = '検証中…';
  try {
    const r = await api('/api/diary/test-github', { method: 'POST' });
    const fmt = r.token_format
      ? `format: ${r.token_format.fine_grained ? 'fine-grained' : r.token_format.classic ? 'classic' : 'unknown'} (${r.token_format.length} 文字)`
      : '';
    const probeLines = (r.probes || []).map(p => {
      if (p.error) return `<li><code>${escapeHtml(p.name)}</code>: ${escapeHtml(p.error)}</li>`;
      const s = p.ok ? `<span style="color:#1f7a1f">${p.status}</span>` : `<span style="color:var(--danger)">${p.status}</span>`;
      return `<li><code>${escapeHtml(p.name)}</code>: ${s} ${escapeHtml((p.body || '').slice(0, 80))}</li>`;
    }).join('');
    if (r.ok) {
      el.innerHTML = `
        <div style="color:#1f7a1f">✓ ${escapeHtml(r.login || '')} として認証 OK${r.scopes ? ` (scopes: ${escapeHtml(r.scopes)})` : ''}</div>
        <div style="font-size:11px;color:var(--muted)">${escapeHtml(fmt)}</div>
        <ul class="diary-probe-list">${probeLines}</ul>`;
    } else {
      el.innerHTML = `
        <div style="color:var(--danger)">✗ ${escapeHtml(r.error ? `error: ${r.error}` : `status ${r.status}`)}</div>
        ${r.hint ? `<div style="font-size:12px;color:#8a5a00">ヒント: ${escapeHtml(r.hint)}</div>` : ''}
        <div style="font-size:11px;color:var(--muted)">${escapeHtml(fmt)}</div>
        <ul class="diary-probe-list">${probeLines}</ul>`;
    }
  } catch (e) {
    el.textContent = `エラー: ${e.message}`;
  }
}

async function saveDiarySettings() {
  try {
    await api('/api/diary/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        github_user: $('diaryGhUser').value.trim(),
        github_repos: $('diaryGhRepos').value.trim(),
        github_token: $('diaryGhToken').value,
      }),
    });
    $('diaryGhToken').value = '';
    flashToast('GitHub 設定を保存しました');
    openDiarySettings();
  } catch (e) {
    alert(`保存失敗: ${e.message}`);
  }
}

async function loadRecommendations(force = false) {
  try {
    const url = '/api/recommendations' + (force ? '?force=1' : '');
    const { items } = await api(url);
    state.recommendations = items;
    renderRecommendations();
  } catch (e) {
    console.error('rec load failed', e);
  }
}

function renderRecommendations() {
  const items = state.recommendations;
  const list = $('recList');
  const empty = $('recEmpty');
  const badge = $('tabRecommendCount');
  if (items.length > 0) {
    badge.classList.remove('hidden');
    badge.textContent = items.length;
  } else {
    badge.classList.add('hidden');
  }
  if (items.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = items.map(r => {
    const sources = (r.sources || []).map(s => escapeHtml(s.title)).slice(0, 3).join(' / ');
    return `
      <div class="rec-card" data-url="${escapeHtml(r.url)}">
        <div class="domain">${escapeHtml(r.domain)}<span class="rec-score">${r.source_count} 件の記事から</span></div>
        <div class="anchor">${escapeHtml(r.anchor || r.url)}</div>
        <div class="url">${escapeHtml(r.url)}</div>
        <div class="why">参照元: ${sources}${(r.sources || []).length > 3 ? ' …' : ''}</div>
        <div class="actions">
          <button class="rec-save">保存</button>
          <a class="ghost rec-open" href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer">開く</a>
          <button class="ghost rec-dismiss">却下</button>
        </div>
      </div>
    `;
  }).join('');
  list.querySelectorAll('.rec-card').forEach(card => {
    const url = card.dataset.url;
    card.querySelector('.rec-save').addEventListener('click', async () => {
      card.querySelector('.rec-save').disabled = true;
      try {
        await api('/api/visits/bookmark', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: [url] }),
        });
        card.remove();
        state.recommendations = state.recommendations.filter(r => r.url !== url);
        renderRecommendations();
        await refreshQueue();
      } catch (e) {
        alert(`保存失敗: ${e.message}`);
      }
    });
    card.querySelector('.rec-dismiss').addEventListener('click', async () => {
      try {
        await api('/api/recommendations/dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        card.remove();
        state.recommendations = state.recommendations.filter(r => r.url !== url);
        renderRecommendations();
      } catch (e) {
        alert(`却下失敗: ${e.message}`);
      }
    });
  });
}

// ── trends ─────────────────────────────────────────────────────────────

async function loadTrends() {
  const days = state.trendsRange;
  try {
    const [cats, diff, timeline, domains, visitDomains, workHours, keywords, github] = await Promise.all([
      api(`/api/trends/categories?days=${encodeURIComponent(days)}`),
      api(`/api/trends/category-diff?days=7`),
      api(`/api/trends/timeline?days=${encodeURIComponent(days)}`),
      api(`/api/trends/domains?days=${encodeURIComponent(days)}`),
      api(`/api/trends/visit-domains?days=${encodeURIComponent(days)}`),
      api(`/api/trends/work-hours?days=${encodeURIComponent(days)}`),
      api(`/api/trends/keywords?days=${encodeURIComponent(days)}`),
      api(`/api/trends/github?days=${encodeURIComponent(days)}`).catch(() => ({ enabled: false })),
    ]);
    renderTrendCategories(cats.items);
    renderTrendDiff(diff.items);
    renderTrendTimeline(timeline.items);
    renderTrendDomains(domains.items);
    renderTrendVisitDomains(visitDomains.items);
    renderTrendWorkHours(workHours.items);
    renderTrendKeywords(keywords.items);
    renderTrendGithub(github);
  } catch (e) {
    console.error('trends load failed', e);
  }
}

function renderTrendCategories(items) {
  // Clickable horizontal bars: each row gets a `data-category` so the
  // event listener below can route to the bookmarks tab filtered by it.
  $('trendCategories').innerHTML = svgHorizontalBar(items, c => c.category, c => c.count, '', {
    rowAttr: c => `data-category="${escapeHtml(c.category)}"`,
    rowClass: 'clickable',
  });
  $('trendCategories').querySelectorAll('[data-category]').forEach(el => {
    el.addEventListener('click', () => {
      const cat = el.dataset.category;
      if (!cat) return;
      state.category = cat;
      switchTab('bookmarks');
      load();
    });
    el.style.cursor = 'pointer';
  });
}

function renderTrendDomains(items) {
  $('trendDomains').innerHTML = svgHorizontalBar(items, c => c.domain, c => c.hits, 'alt', {
    rowAttr: c => `data-domain="${escapeHtml(c.domain)}"`,
    rowClass: 'clickable',
  });
  attachDomainClick($('trendDomains'));
}

function renderTrendVisitDomains(items) {
  $('trendVisitDomains').innerHTML = svgHorizontalBar(items, c => c.domain, c => c.visits, 'alt', {
    rowAttr: c => `data-domain="${escapeHtml(c.domain)}"`,
    rowClass: 'clickable',
  });
  attachDomainClick($('trendVisitDomains'));
}

function attachDomainClick(root) {
  if (!root) return;
  root.querySelectorAll('[data-domain]').forEach(el => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', async () => {
      const domain = el.dataset.domain;
      if (!domain) return;
      switchTab('domain');
      await new Promise(r => setTimeout(r, 0));
      try { await loadDomainEntry(domain); }
      catch (err) {
        try {
          await api(`/api/domains/${encodeURIComponent(domain)}/regenerate`, { method: 'POST' });
          flashToast(`「${domain}」を分類キューに追加しました`);
          await loadDomainCatalog();
        } catch (e2) { console.error(e2); }
      }
    });
  });
}

function renderTrendKeywords(items) {
  const el = $('trendKeywords');
  if (!el) return;
  if (!items.length) { el.innerHTML = '<div class="queue-empty">データなし</div>'; return; }
  const max = Math.max(...items.map(i => i.count), 1);
  el.innerHTML = items.map(i => {
    const weight = 0.7 + (i.count / max) * 0.5;          // 0.7–1.2
    const fontSz = 11 + (i.count / max) * 7;             // 11–18 px
    return `<span class="trend-kw" style="font-size:${fontSz.toFixed(1)}px;font-weight:${Math.round(weight * 600)}" title="${i.count} 回">${escapeHtml(i.word)} <span class="trend-kw-n">${i.count}</span></span>`;
  }).join('');
}

function renderTrendWorkHours(items) {
  const el = $('trendWorkHours');
  if (!el) return;
  if (!items?.length) { el.innerHTML = '<div class="queue-empty">データなし</div>'; return; }
  // items: [{date: 'YYYY-MM-DD', minutes}]
  const data = items.map(d => ({ date: d.date, value: d.minutes / 60, raw: d.minutes }));
  el.innerHTML = renderLineChartSvg(data, {
    yLabel: (v) => `${v.toFixed(1)}h`,
    pointLabel: (d) => `${d.date} : ${(d.value).toFixed(1)} 時間 (${d.raw} 分)`,
  });
  attachLineChartTooltip(el);
}

function renderTrendGithub(payload) {
  const card = $('trendGithubCard');
  if (!card) return;
  if (!payload?.enabled) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  if (payload.error) {
    $('trendGithubSummary').textContent = `取得失敗: ${payload.error}`;
    $('trendGithubChart').innerHTML = '';
    $('trendGithubRepos').innerHTML = '';
    return;
  }
  $('trendGithubSummary').textContent = `期間内 ${payload.total} commits / ${payload.repos.length} リポジトリ`;
  const series = (payload.series || []).map(d => ({ date: d.date, value: d.count, raw: d.count }));
  $('trendGithubChart').innerHTML = renderLineChartSvg(series, {
    yLabel: (v) => `${Math.round(v)}`,
    pointLabel: (d) => `${d.date} : ${d.value} commits`,
    klass: 'gh',
  });
  attachLineChartTooltip($('trendGithubChart'));
  $('trendGithubRepos').innerHTML = (payload.repos || []).map(r => `
    <li>
      <span class="repo">${escapeHtml(r.repo)}</span>
      <span class="count">${r.count} commits</span>
    </li>
  `).join('');
}

function svgHorizontalBar(items, labelFn, valueFn, klass = '', opts = {}) {
  if (!items.length) return '<div class="queue-empty">データなし</div>';
  const max = Math.max(...items.map(valueFn), 1);
  const rowH = 22, padTop = 4, padLeft = 130, padRight = 40, w = 460;
  const h = padTop * 2 + items.length * rowH;
  const rows = items.map((it, i) => {
    const v = valueFn(it);
    const len = Math.round((v / max) * (w - padLeft - padRight));
    const y = padTop + i * rowH;
    const label = String(labelFn(it)).slice(0, 18);
    const attr = opts.rowAttr ? opts.rowAttr(it) : '';
    const rowClass = opts.rowClass || '';
    return `
      <g class="bar-row ${rowClass}" ${attr}>
        <rect class="bar-hit" x="0" y="${y}" width="${w}" height="${rowH}" fill="transparent" />
        <text class="label" x="${padLeft - 8}" y="${y + 14}" text-anchor="end">${escapeHtml(label)}</text>
        <rect class="bar ${klass}" x="${padLeft}" y="${y + 4}" width="${len}" height="14" rx="2" />
        <text class="label" x="${padLeft + len + 6}" y="${y + 14}">${v}</text>
      </g>
    `;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMinYMin meet">${rows}</svg>`;
}

// Generic line chart returning an SVG string. `data` = [{date, value, raw}].
// Hover tooltips are wired up by attachLineChartTooltip(container).
function renderLineChartSvg(data, { yLabel, pointLabel, klass = '' } = {}) {
  if (!data?.length) return '<div class="queue-empty">データなし</div>';
  const w = 600, h = 200, padL = 40, padR = 12, padT = 12, padB = 24;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const max = Math.max(1, ...data.map(d => d.value || 0));
  const xStep = innerW / Math.max(1, data.length - 1);
  const points = data.map((d, i) => {
    const x = padL + i * xStep;
    const y = padT + innerH - ((d.value || 0) / max) * innerH;
    return { x, y, d, i };
  });
  const polyline = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const yLabelFn = yLabel || (v => String(Math.round(v * 10) / 10));
  const yLabels = [0, max / 2, max].map(v => {
    const y = padT + innerH - (v / max) * innerH;
    return `<text class="label" x="${padL - 6}" y="${y + 3}" text-anchor="end">${yLabelFn(v)}</text>
            <line class="grid" x1="${padL}" y1="${y}" x2="${padL + innerW}" y2="${y}" />`;
  }).join('');
  const xLabelStep = Math.max(1, Math.floor(data.length / 6));
  const xLabels = data.map((d, i) => {
    if (i % xLabelStep !== 0 && i !== data.length - 1) return '';
    const x = padL + i * xStep;
    const md = (d.date || '').slice(5);
    return `<text class="label" x="${x.toFixed(1)}" y="${h - 6}" text-anchor="middle">${md}</text>`;
  }).join('');
  const dots = points.map(p => `<circle class="dot ${klass}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" />`).join('');
  const hits = points.map(p => `
    <circle class="hit" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="14"
      data-x="${p.x.toFixed(1)}" data-y="${p.y.toFixed(1)}"
      data-label="${escapeHtml(pointLabel ? pointLabel(p.d) : `${p.d.date}: ${p.d.value}`)}"
      fill="transparent" />
  `).join('');
  return `
    <div class="line-chart">
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMinYMin meet">
        ${yLabels}
        <polyline class="line ${klass}" points="${polyline}" />
        ${dots}
        ${hits}
        ${xLabels}
      </svg>
      <div class="line-chart-tip" hidden></div>
    </div>
  `;
}

function attachLineChartTooltip(container) {
  if (!container) return;
  const wrap = container.querySelector('.line-chart');
  const svg = wrap?.querySelector('svg');
  const tip = wrap?.querySelector('.line-chart-tip');
  if (!wrap || !svg || !tip) return;
  function show(target) {
    tip.textContent = target.dataset.label || '';
    tip.hidden = false;
    const cx = parseFloat(target.dataset.x);
    const cy = parseFloat(target.dataset.y);
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const px = (cx / vb.width) * rect.width;
    const py = (cy / vb.height) * rect.height;
    tip.style.left = `${px + 8}px`;
    tip.style.top = `${py - 24}px`;
  }
  function hide() { tip.hidden = true; }
  for (const hit of svg.querySelectorAll('.hit')) {
    hit.addEventListener('mouseenter', () => show(hit));
    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('focus', () => show(hit));
    hit.addEventListener('blur', hide);
    hit.setAttribute('tabindex', '0');
  }
}

function renderTrendTimeline(items) {
  const el = $('trendTimeline');
  if (!items.length) { el.innerHTML = '<div class="queue-empty">データなし</div>'; return; }
  const w = 600, h = 200, padL = 40, padR = 12, padT = 12, padB = 24;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const max = Math.max(1, ...items.flatMap(d => [d.saves, d.accesses]));
  const xStep = innerW / Math.max(1, items.length - 1);
  function ptsFor(key) {
    return items.map((d, i) => ({
      x: padL + i * xStep,
      y: padT + innerH - (d[key] / max) * innerH,
      d, key,
    }));
  }
  const savesPts = ptsFor('saves');
  const accPts = ptsFor('accesses');
  const polyline = (pts) => pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const dotsFor = (pts, klass) => pts.map(p => `<circle class="${klass}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" />`).join('');
  const hitsFor = (pts, key) => pts.map(p => `
    <circle class="hit" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="12"
      data-x="${p.x.toFixed(1)}" data-y="${p.y.toFixed(1)}"
      data-label="${escapeHtml(`${p.d.date} : ${key === 'saves' ? '保存' : 'アクセス'} ${p.d[key]}`)}"
      fill="transparent" />
  `).join('');
  const yLabels = [0, Math.round(max / 2), max].map(v => {
    const y = padT + innerH - (v / max) * innerH;
    return `<text class="label" x="${padL - 6}" y="${y + 3}" text-anchor="end">${v}</text>
            <line class="grid" x1="${padL}" y1="${y}" x2="${padL + innerW}" y2="${y}" />`;
  }).join('');
  const xLabelStep = Math.max(1, Math.floor(items.length / 6));
  const xLabels = items.map((d, i) => {
    if (i % xLabelStep !== 0 && i !== items.length - 1) return '';
    const x = padL + i * xStep;
    return `<text class="label" x="${x.toFixed(1)}" y="${h - 6}" text-anchor="middle">${d.date.slice(5)}</text>`;
  }).join('');
  el.innerHTML = `
    <div class="line-chart">
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMinYMin meet">
        ${yLabels}
        <polyline class="line-saves" points="${polyline(savesPts)}" />
        <polyline class="line-accesses" points="${polyline(accPts)}" />
        ${dotsFor(savesPts, 'dot')}
        ${dotsFor(accPts, 'dot-alt')}
        ${hitsFor(savesPts, 'saves')}
        ${hitsFor(accPts, 'accesses')}
        ${xLabels}
      </svg>
      <div class="line-chart-tip" hidden></div>
    </div>
    <div class="chart-legend">
      <span><span class="dot saves"></span>新規保存</span>
      <span><span class="dot accesses"></span>アクセス</span>
    </div>
  `;
  attachLineChartTooltip(el);
}

function renderTrendDiff(items) {
  if (!items.length) { $('trendDiff').innerHTML = '<li>データなし</li>'; return; }
  $('trendDiff').innerHTML = items.map(d => {
    const sign = d.delta > 0 ? '+' : '';
    const cls = d.delta > 0 ? 'up' : d.delta < 0 ? 'down' : '';
    const ratio = d.previous > 0 ? `${d.previous}→${d.current}` : `新規 ${d.current}`;
    return `
      <li>
        <span>${escapeHtml(d.category)}</span>
        <span class="ratio">${ratio}</span>
        <span class="delta ${cls}">${sign}${d.delta}</span>
      </li>
    `;
  }).join('');
}

async function loadVisits() {
  try {
    let items;
    if (state.visitsRange === 'today') {
      ({ items } = await api('/api/visits/unsaved'));
      // Today endpoint doesn't include score; synthesize zero so render works.
      items = items.map(i => ({ ...i, domain: hostOf(i.url), same_domain_bookmarks: 0, same_path_prefix_bookmarks: 0, score: 0 }));
    } else {
      ({ items } = await api(`/api/visits/suggested?days=${encodeURIComponent(state.visitsRange)}`));
    }
    state.visits = items;
    const urls = new Set(items.map(i => i.url));
    state.visitsSelected = new Set([...state.visitsSelected].filter(u => urls.has(u)));
    renderVisits();
  } catch (e) {
    console.error(e);
  }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function renderVisits() {
  const items = state.visits;
  const tabBadge = $('tabVisitsCount');
  if (items.length > 0) {
    tabBadge.classList.remove('hidden');
    tabBadge.textContent = items.length;
  } else {
    tabBadge.classList.add('hidden');
  }
  $('visitsSelCount').textContent = state.visitsSelected.size;
  $('visitsAll').checked = items.length > 0 && state.visitsSelected.size === items.length;

  const list = $('visitsList');
  const empty = $('visitsEmpty');
  if (items.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = items.map(v => {
    const sel = state.visitsSelected.has(v.url);
    const dom = v.domain || hostOf(v.url);
    const hot = (v.score ?? 0) >= 10;
    const badge = hot
      ? `<span class="suggest-badge">同ドメイン保存 ${v.same_domain_bookmarks}</span>`
      : '';
    const cat = v.catalog;
    const pg = v.page;
    // Per-URL summary (Sonnet) takes priority. Fallback to the page's own
    // meta description, then the domain-level description.
    let pageLine = '';
    if (pg?.summary) {
      pageLine = `<div class="visits-page">${pg.kind ? `<span class="visits-kind">${escapeHtml(pg.kind)}</span> ` : ''}${escapeHtml(pg.summary)}</div>`;
    } else if (pg?.meta_description || pg?.og_description) {
      pageLine = `<div class="visits-page">${escapeHtml(pg.meta_description || pg.og_description)}</div>`;
    } else if (pg?.status === 'pending' || !pg) {
      pageLine = `<div class="visits-page pending">ページ情報を取得中…</div>`;
    } else if (pg?.status === 'skipped') {
      pageLine = '';
    } else if (pg?.status === 'error' || !pg?.summary) {
      // Fallback: use the domain catalog's site_name when per-URL fetch failed.
      if (cat?.site_name || cat?.description) {
        pageLine = `<div class="visits-page">${cat.kind ? `<span class="visits-kind">${escapeHtml(cat.kind)}</span> ` : ''}<strong>${escapeHtml(cat.site_name || '')}</strong>${cat.description ? ` — ${escapeHtml(cat.description)}` : ''}</div>`;
      } else {
        pageLine = `<div class="visits-page pending">取得失敗</div>`;
      }
    }
    const catLine = cat?.description
      ? `<div class="visits-catalog"><span class="visits-domain-prefix">[ドメイン] </span>${cat.kind ? `<span class="visits-kind">${escapeHtml(cat.kind)}</span> ` : ''}${escapeHtml(cat.description)}</div>`
      : (cat?.status === 'pending' ? `<div class="visits-catalog pending">ドメイン分類中…</div>` : '');
    // Title fallback chain: Sonnet page_title → recorded title (only if
    // it isn't itself a URL) → domain catalog site_name → bare domain.
    // The URL fallback was leaking through whenever the page never
    // resolved a title — we now prefer the human-readable domain info.
    const titleLooksLikeUrl = (s) => typeof s === 'string' && /^\s*https?:\/\//i.test(s);
    const realTitle = pg?.page_title
      || (titleLooksLikeUrl(v.title) ? null : v.title)
      || cat?.site_name
      || dom
      || v.url;
    const titleText = realTitle;
    return `
      <li class="${sel ? 'selected' : ''} ${hot ? 'hot' : ''}" data-url="${escapeHtml(v.url)}">
        <input type="checkbox" class="vchk" ${sel ? 'checked' : ''} />
        <div style="min-width:0">
          <div class="title">${escapeHtml(titleText)} ${badge}</div>
          <div class="url">${escapeHtml(v.url)}</div>
          <div class="visits-meta">
            <a class="visits-domain-link" href="#" data-domain="${escapeHtml(dom)}" title="${escapeHtml(dom)} のドメイン辞書を開く">${escapeHtml(dom)}</a>
            ${v.score ? ` · score ${v.score}` : ''}
          </div>
          ${pageLine}
          ${catLine}
        </div>
        <div class="when">
          ${fmtDate(v.last_seen_at)}<br>
          <span class="count">${v.visit_count} 回</span>
        </div>
      </li>
    `;
  }).join('');
  list.querySelectorAll('li').forEach(li => {
    const url = li.dataset.url;
    const cb = li.querySelector('.vchk');
    li.addEventListener('click', (e) => {
      // Clicks on the domain link / select / inputs shouldn't toggle the
      // bookmark checkbox.
      if (e.target.closest('.visits-domain-link, a, button, input')) return;
      if (e.target !== cb) {
        cb.checked = !cb.checked;
      }
      if (cb.checked) state.visitsSelected.add(url);
      else state.visitsSelected.delete(url);
      li.classList.toggle('selected', cb.checked);
      $('visitsSelCount').textContent = state.visitsSelected.size;
      $('visitsAll').checked = state.visitsSelected.size === state.visits.length;
    });
  });
  list.querySelectorAll('.visits-domain-link').forEach(a => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const domain = a.dataset.domain;
      if (!domain) return;
      switchTab('domain');
      // Wait for loadDomainCatalog (kicked off by switchTab) to settle
      // so the list is populated before we pin the entry.
      await new Promise(r => setTimeout(r, 0));
      try {
        await loadDomainEntry(domain);
      } catch (err) {
        // 404: domain hasn't been catalogued yet. Queue a fresh
        // classification + show a placeholder.
        try {
          await api(`/api/domains/${encodeURIComponent(domain)}/regenerate`, { method: 'POST' });
          flashToast(`「${domain}」を分類キューに追加しました`);
          await loadDomainCatalog();
        } catch (err2) {
          console.error(err2);
          alert(`ドメイン情報の取得失敗: ${err2.message}`);
        }
      }
    });
  });
}

async function bookmarkSelectedVisits() {
  const urls = [...state.visitsSelected];
  if (urls.length === 0) return;
  const btn = $('visitsBookmark');
  btn.disabled = true;
  btn.textContent = '取得中...';
  $('visitsResults').innerHTML = '';
  try {
    const r = await api('/api/visits/bookmark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls }),
    });
    const lines = r.results.map(it => {
      if (it.status === 'queued') return `<li class="ok">✓ キュー投入: ${escapeHtml(it.url)} (id=${it.id})</li>`;
      if (it.status === 'duplicate') return `<li class="dup">既存: ${escapeHtml(it.url)} (id=${it.id})</li>`;
      if (it.status === 'skipped') return `<li class="err">スキップ: ${escapeHtml(it.url)} (${escapeHtml(it.error)})</li>`;
      return `<li class="err">✗ 失敗: ${escapeHtml(it.url)} — ${escapeHtml(it.error || '不明')}</li>`;
    });
    $('visitsResults').innerHTML = lines.join('');
    state.visitsSelected.clear();
    await loadVisits();
    await load();
    await refreshQueue();
  } catch (e) {
    alert(`保存失敗: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '選択をブックマークに保存';
  }
}

async function deleteSelectedVisits() {
  const urls = [...state.visitsSelected];
  if (urls.length === 0) return;
  if (!confirm(`${urls.length} 件を履歴から削除しますか？(ブックマークには影響しません)`)) return;
  await api('/api/visits', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }),
  });
  state.visitsSelected.clear();
  await loadVisits();
}

document.querySelectorAll('.tabs-scroll .tab').forEach(t => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});
$('tabMoreBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('tabMoreMenu');
  const btn = $('tabMoreBtn');
  const open = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
});
document.addEventListener('click', (e) => {
  const menu = $('tabMoreMenu');
  if (!menu || menu.classList.contains('hidden')) return;
  if (e.target.closest('.tabs-more')) return;
  closeTabMoreMenu();
});
window.addEventListener('resize', reflowTabsForViewport);
reflowTabsForViewport();
setupCategoriesDrawer();
setupExtensionBadge();
setupMobileTabSelect();
setupHowToBookmark();

// Mobile <select> for tabs — fires switchTab() on change.
function setupMobileTabSelect() {
  const sel = $('mobileTabSelect');
  if (!sel) return;
  sel.value = state.tab || 'bookmarks';
  sel.addEventListener('change', () => switchTab(sel.value));
}

// 💡 やり方 button — only shows on mobile (no Chrome extension available).
function setupHowToBookmark() {
  const btn = $('howToBookmarkBtn');
  const overlay = $('howToBookmarkOverlay');
  const close = $('howToBookmarkClose');
  if (!btn || !overlay) return;
  // Show only when viewport is mobile-ish — desktop uses the Chrome
  // extension, so this prompt isn't relevant.
  function syncVisibility() {
    btn.hidden = window.innerWidth > 760;
  }
  syncVisibility();
  window.addEventListener('resize', syncVisibility);
  btn.addEventListener('click', () => { overlay.hidden = false; });
  close?.addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) overlay.hidden = true;
  });
}

// Extension status badge — only meaningful when running inside the Tauri
// desktop wrapper (a regular browser tab doesn't need the prompt). Polls
// /api/extension/status every 30 s and updates the topbar pill.
function isTauri() {
  return !!(window.__TAURI_INTERNALS__ || window.__TAURI__ || window.__TAURI_METADATA__);
}
async function refreshExtensionBadge() {
  const badge = $('extensionBadge');
  if (!badge) return;
  if (!isTauri()) {
    badge.hidden = true;
    return;
  }
  try {
    const s = await api('/api/extension/status');
    badge.hidden = false;
    if (s.configured) {
      badge.className = 'ext-badge ext-ok';
      badge.textContent = s.active ? '✓ 拡張 OK' : '✓ 拡張接続済';
      badge.title = s.last_seen ? `最終 ping: ${new Date(s.last_seen).toLocaleString()}` : '';
    } else {
      badge.className = 'ext-badge ext-warn';
      badge.textContent = '⚠ 拡張未設定 (クリック)';
      badge.title = 'クリックしてセットアップ手順を表示';
    }
  } catch (e) {
    console.error('extension status failed', e);
  }
}
function setupExtensionBadge() {
  const badge = $('extensionBadge');
  const overlay = $('extensionSetupOverlay');
  const close = $('extensionSetupClose');
  if (!badge || !overlay) return;
  badge.addEventListener('click', () => {
    if (badge.classList.contains('ext-warn')) {
      const urlEl = $('extensionSetupUrl');
      if (urlEl) urlEl.textContent = location.origin || 'http://localhost:5180';
      overlay.hidden = false;
    }
  });
  close?.addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) overlay.hidden = true;
  });
  refreshExtensionBadge();
  setInterval(refreshExtensionBadge, 30_000);
}

$('visitsRefresh').addEventListener('click', loadVisits);
$('visitsRange').addEventListener('change', (e) => {
  state.visitsRange = e.target.value;
  loadVisits();
});
$('trendsRange').addEventListener('change', (e) => {
  state.trendsRange = e.target.value;
  loadTrends();
});
$('recRefresh').addEventListener('click', () => loadRecommendations(true));
$('digRun').addEventListener('click', () => startDig());
$('digQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); startDig(); }
});
$('digFromBookmarks')?.addEventListener('click', startCloudFromBookmarks);
$('dictNewBtn')?.addEventListener('click', createDictionaryEntry);
$('dictSaveBtn')?.addEventListener('click', saveDictionaryEntry);
$('dictDeleteBtn')?.addEventListener('click', deleteDictionaryEntry);
$('dictSearch')?.addEventListener('input', (e) => {
  state.dictSearch = e.target.value.trim();
  loadDictionary();
});
$('diaryPrevMonth')?.addEventListener('click', () => {
  state.diaryMonth = shiftMonth(state.diaryMonth || todayMonth(), -1);
  refreshDiaryMonth();
});
$('diaryNextMonth')?.addEventListener('click', () => {
  state.diaryMonth = shiftMonth(state.diaryMonth || todayMonth(), 1);
  refreshDiaryMonth();
});
$('diaryToday')?.addEventListener('click', () => {
  state.diaryMonth = todayMonth();
  refreshDiaryMonth();
  loadDiaryDetail(todayLocalDate());
});
$('diaryGenerate')?.addEventListener('click', () => generateDiary());
$('diaryImproveBtn')?.addEventListener('click', improveDiary);
$('diaryDelete')?.addEventListener('click', deleteDiaryEntry);
$('diaryNotesSave')?.addEventListener('click', saveDiaryNotes);
$('diarySettingsBtn')?.addEventListener('click', openDiarySettings);
$('diarySettingsSave')?.addEventListener('click', saveDiarySettings);
$('diarySettingsTest')?.addEventListener('click', testGithubPat);
$('diarySettingsClose')?.addEventListener('click', () => $('diarySettingsPanel').classList.add('hidden'));
$('weeklyGenerate')?.addEventListener('click', generateWeekly);
$('weeklyDelete')?.addEventListener('click', deleteWeeklyEntry);
$('domainSearch')?.addEventListener('input', (e) => {
  state.domainSearch = e.target.value.trim();
  loadDomainCatalog();
});
$('domainSaveBtn')?.addEventListener('click', saveDomainEntry);
$('domainRegenBtn')?.addEventListener('click', regenerateDomainEntry);
$('domainDeleteBtn')?.addEventListener('click', deleteDomainEntry);
$('domainRecatalogBtn')?.addEventListener('click', () => recatalogAllDomains({ force: false }));
$('recatalogAllBtn')?.addEventListener('click', () => recatalogAllDomains({ force: false }));
$('recatalogAllForceBtn')?.addEventListener('click', () => recatalogAllDomains({ force: true }));

// ── modal panels (dict + domain edit) ─────────────────────────────────────
function showModal(panelId) {
  $(panelId).classList.remove('hidden');
  $('modalBackdrop').hidden = false;
}
function hideModal(panelId) {
  if (panelId) $(panelId).classList.add('hidden');
  // If neither panel is open after this hide, drop the backdrop too.
  const dictOpen = !$('dictDetail').classList.contains('hidden');
  const domOpen  = !$('domainDetail').classList.contains('hidden');
  $('modalBackdrop').hidden = !(dictOpen || domOpen);
}
function closeAllModals() {
  state.dictDetail = null;
  state.domainDetail = null;
  hideModal('dictDetail');
  hideModal('domainDetail');
}
$('dictDetailClose')?.addEventListener('click', () => {
  state.dictDetail = null;
  hideModal('dictDetail');
});
$('domainDetailClose')?.addEventListener('click', () => {
  state.domainDetail = null;
  hideModal('domainDetail');
});
$('modalBackdrop')?.addEventListener('click', closeAllModals);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modalBackdrop').hidden) {
    closeAllModals();
  }
});
$('visitsBookmark').addEventListener('click', bookmarkSelectedVisits);
$('visitsDelete').addEventListener('click', deleteSelectedVisits);
$('visitsAll').addEventListener('click', (e) => {
  if (e.target.checked) state.visits.forEach(v => state.visitsSelected.add(v.url));
  else state.visitsSelected.clear();
  renderVisits();
});

setInterval(async () => {
  const depth = await refreshQueue();
  await refreshVisitsBadge();
  if (depth > 0 || state.bookmarks.some(b => b.status === 'pending')) load();
  if (state.tab === 'queue') renderQueue();
}, 2000);
refreshQueue();
refreshVisitsBadge();

// ── AI / LLM settings panel ───────────────────────────────────────────
async function openAiSettings() {
  $('aiSettingsPanel').classList.remove('hidden');
  try {
    const r = await api('/api/llm/config');
    const cfg = r.config;
    const tasks = r.tasks;
    const providers = r.providers;
    const optionsHtml = providers.map(p => `<option value="${p.key}">${escapeHtml(p.label)}</option>`).join('');
    $('aiTaskRows').innerHTML = tasks.map(t => `
      <div class="ai-task-row">
        <label>${escapeHtml(t)}</label>
        <select data-task="${t}" class="ai-task-provider">${optionsHtml}</select>
        <input data-task="${t}" class="ai-task-model" type="text" placeholder="モデル名 (任意)" />
      </div>
    `).join('');
    for (const t of tasks) {
      const tCfg = cfg.tasks?.[t] || {};
      $('aiTaskRows').querySelector(`select[data-task="${t}"]`).value = tCfg.provider || 'claude';
      $('aiTaskRows').querySelector(`input[data-task="${t}"]`).value = tCfg.model || '';
    }
    $('aiBinClaude').value = cfg.bins?.claude || '';
    $('aiBinGemini').value = cfg.bins?.gemini || '';
    $('aiBinCodex').value  = cfg.bins?.codex  || '';
    $('aiGitBashPath').value = cfg.git_bash_path || '';
    $('aiOpenaiKey').value = '';
    $('aiOpenaiModel').value = cfg.openai_model || '';
    $('aiOpenaiKeyStatus').textContent = cfg.openai_api_key_set ? '✓ API key 設定済み (再入力で上書き)' : '(未設定)';
    if ($('aiDiaryGlobalMemo')) $('aiDiaryGlobalMemo').value = cfg.diary_global_memo || '';
    if (r.runtime) {
      const rt = r.runtime;
      $('aiRuntimeInfo').innerHTML = `
        <div><b>port</b>: ${escapeHtml(String(rt.port))}</div>
        <div><b>data_dir</b>: <code>${escapeHtml(rt.data_dir)}</code></div>
        <div><b>platform</b>: ${escapeHtml(rt.platform)}</div>
      `;
    }
  } catch (e) {
    console.error(e);
    alert(`設定取得失敗: ${e.message}`);
  }
  await refreshMultiStatus();
}

// ── Multi-server (Memoria Hub) connection ─────────────────────────────────
async function refreshMultiStatus() {
  try {
    const s = await api('/api/multi/status');
    state.multi = s;
    renderMultiSwitch(s);
    renderMultiServersList(s);
    const status = $('multiStatus');
    if (status) {
      const activeCount = (s.servers || []).filter(x => x.active && x.connected).length;
      if (activeCount > 0) {
        status.innerHTML = `✓ ${activeCount} サーバが接続中`;
      } else if ((s.servers || []).length === 0) {
        status.textContent = '(URL を追加してください)';
      } else {
        status.textContent = '未接続';
      }
    }
    // Share buttons reflect whether ANY server is active+connected.
    const anyConnected = !!(s.servers || []).some(x => x.active && x.connected);
    document.querySelectorAll('#dShare, #dictShareBtn, #digShareBtn').forEach(b => {
      b.hidden = !anyConnected;
    });
    if (!anyConnected && $('digShareBar')) $('digShareBar').hidden = true;
    if (typeof refreshMultiTabVisibility === 'function') refreshMultiTabVisibility();
  } catch (e) { console.error(e); }
}

function renderMultiSwitch(s) {
  const root = $('multiSwitch');
  if (!root) return;
  const servers = s?.servers || [];
  if (!servers.length) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  root.hidden = false;
  // ローカル baseline pill (always-on, just visual reminder) +
  // one toggleable pill per registered remote.
  const items = [
    `<span class="ms-pill ms-local active" title="ローカル DB は常に有効">🏠 ローカル</span>`,
    ...servers.map(sv => {
      const cls = sv.active ? 'active' : '';
      const labelTxt = sv.label || sv.url;
      const tip = sv.connected
        ? `${sv.url} (${sv.user?.name || ''})`
        : `${sv.url} — 未認証`;
      return `<button type="button" class="ms-pill ${cls}" data-url="${escapeHtml(sv.url)}" title="${escapeHtml(tip)}">${escapeHtml(labelTxt)}</button>`;
    }),
  ];
  root.innerHTML = items.join('');
  root.querySelectorAll('.ms-pill[data-url]').forEach(btn => {
    btn.addEventListener('click', () => toggleMultiActive(btn.dataset.url));
  });
}

async function toggleMultiActive(url) {
  // Multi-select: clicking flips this server's membership in the active set.
  const s = state.multi;
  if (!s) return;
  const active = (s.servers || []).filter(x => x.active).map(x => x.url);
  const set = new Set(active);
  if (set.has(url)) set.delete(url);
  else set.add(url);
  // If the server isn't yet authenticated, kick off OAuth instead.
  const target = (s.servers || []).find(x => x.url === url);
  if (target && set.has(url) && !target.connected) {
    const r = await api('/api/multi/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, redirect_uri: location.origin + '/' }),
    });
    location.href = r.authorize_url;
    return;
  }
  await api('/api/multi/active', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: [...set] }),
  });
  await refreshMultiStatus();
}

function renderMultiServersList(s) {
  const list = $('multiServersList');
  if (!list) return;
  const servers = s?.servers || [];
  if (!servers.length) {
    list.innerHTML = '<li class="multi-server-empty">登録されたマルチサーバはありません。下のフォームから追加してください。</li>';
    return;
  }
  list.innerHTML = servers.map(sv => {
    const status = sv.connected
      ? `<span class="ms-status ok">✓ ${escapeHtml(sv.user?.name || '')} (${escapeHtml(sv.user?.role || '')})</span>`
      : '<span class="ms-status">未認証</span>';
    return `<li class="multi-server-row" data-url="${escapeHtml(sv.url)}">
      <label class="ms-active-toggle">
        <input type="checkbox" data-url="${escapeHtml(sv.url)}" ${sv.active ? 'checked' : ''} />
        有効
      </label>
      <div class="ms-row-body">
        <div class="ms-label">${escapeHtml(sv.label)}</div>
        <div class="ms-url"><code>${escapeHtml(sv.url)}</code></div>
        <div>${status}</div>
      </div>
      <div class="ms-row-actions">
        <button class="ghost ghost-sm" data-action="connect" data-url="${escapeHtml(sv.url)}">${sv.connected ? '再接続' : '接続'}</button>
        <button class="ghost ghost-sm" data-action="disconnect" data-url="${escapeHtml(sv.url)}" ${sv.connected ? '' : 'disabled'}>切断</button>
        <button class="danger ghost-sm" data-action="remove" data-url="${escapeHtml(sv.url)}">削除</button>
      </div>
    </li>`;
  }).join('');
  list.querySelectorAll('input[type=checkbox][data-url]').forEach(cb => {
    cb.addEventListener('change', () => toggleMultiActive(cb.dataset.url));
  });
  list.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => multiServerAction(btn.dataset.action, btn.dataset.url));
  });
}

async function multiServerAction(action, url) {
  if (action === 'connect') {
    const r = await api('/api/multi/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, redirect_uri: location.origin + '/' }),
    });
    location.href = r.authorize_url;
    return;
  }
  if (action === 'disconnect') {
    if (!confirm(`「${url}」から切断しますか?`)) return;
    await api('/api/multi/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    await refreshMultiStatus();
    return;
  }
  if (action === 'remove') {
    if (!confirm(`「${url}」を登録解除しますか?`)) return;
    await api('/api/multi/servers', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    await refreshMultiStatus();
    return;
  }
}

async function multiAddServer() {
  const url = ($('multiAddUrl')?.value || '').trim();
  const label = ($('multiAddLabel')?.value || '').trim();
  if (!url) { alert('URL を入力してください'); return; }
  await api('/api/multi/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, label: label || url }),
  });
  $('multiAddUrl').value = '';
  $('multiAddLabel').value = '';
  await refreshMultiStatus();
}

async function multiFinishFromUrl() {
  const params = new URLSearchParams(location.search);
  const jwt = params.get('memoria_hub_jwt');
  if (!jwt) return;
  try {
    // Use the most-recently-touched server as target if no explicit URL.
    const r = await api('/api/multi/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwt }),
    });
    showShareToast(`🌐 ${r.user.displayName} (${r.url}) として接続しました`);
  } catch (e) {
    alert(`マルチ接続失敗: ${e.message}`);
  } finally {
    history.replaceState({}, '', location.pathname);
    await refreshMultiStatus();
  }
}

function showShareToast(text) {
  const div = document.createElement('div');
  div.className = 'share-toast';
  div.textContent = text;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 4000);
}

async function shareCurrentBookmark() {
  if (state.detailId == null) return;
  const btn = $('dShare');
  btn.disabled = true;
  $('dShareStatus').textContent = '送信中…';
  try {
    await api('/api/multi/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'bookmark', id: state.detailId }),
    });
    $('dShareStatus').textContent = '✓ 共有しました';
  } catch (e) {
    $('dShareStatus').textContent = `✗ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function shareCurrentDict() {
  if (!state.dictDetail?.id) return;
  const btn = $('dictShareBtn');
  btn.disabled = true;
  $('dictShareStatus').textContent = '送信中…';
  try {
    await api('/api/multi/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'dict', id: state.dictDetail.id }),
    });
    $('dictShareStatus').textContent = '✓ 共有しました';
  } catch (e) {
    $('dictShareStatus').textContent = `✗ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function shareCurrentDig() {
  if (!state.digSession?.id) return;
  const btn = $('digShareBtn');
  btn.disabled = true;
  $('digShareStatus').textContent = '送信中…';
  try {
    await api('/api/multi/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'dig', id: state.digSession.id }),
    });
    $('digShareStatus').textContent = '✓ 共有しました';
  } catch (e) {
    $('digShareStatus').textContent = `✗ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function saveAiSettings() {
  const tasks = {};
  document.querySelectorAll('.ai-task-row').forEach(row => {
    const sel = row.querySelector('.ai-task-provider');
    const inp = row.querySelector('.ai-task-model');
    const t = sel.dataset.task;
    tasks[t] = { provider: sel.value, model: inp.value.trim() };
  });
  const body = {
    tasks,
    bins: {
      claude: $('aiBinClaude').value.trim() || 'claude',
      gemini: $('aiBinGemini').value.trim() || 'gemini',
      codex:  $('aiBinCodex').value.trim()  || 'codex',
    },
    openai_model: $('aiOpenaiModel').value.trim() || 'gpt-4o-mini',
    git_bash_path: $('aiGitBashPath').value.trim(),
    diary_global_memo: $('aiDiaryGlobalMemo')?.value || '',
  };
  const k = $('aiOpenaiKey').value;
  if (k && k !== '***') body.openai_api_key = k;
  try {
    await api('/api/llm/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    alert('保存しました。次回のジョブから反映されます。');
    $('aiSettingsPanel').classList.add('hidden');
  } catch (e) {
    alert(`保存失敗: ${e.message}`);
  }
}

document.getElementById('aiSettingsBtn')?.addEventListener('click', openAiSettings);
document.getElementById('aiSettingsClose')?.addEventListener('click', () => $('aiSettingsPanel').classList.add('hidden'));
document.getElementById('aiSettingsSave')?.addEventListener('click', saveAiSettings);
document.getElementById('multiAddBtn')?.addEventListener('click', multiAddServer);
document.getElementById('dShare')?.addEventListener('click', shareCurrentBookmark);
document.getElementById('dictShareBtn')?.addEventListener('click', shareCurrentDict);
document.getElementById('digShareBtn')?.addEventListener('click', shareCurrentDig);

// Pull JWT out of OAuth redirect on first paint, then prime the share buttons.
multiFinishFromUrl();
refreshMultiStatus();

// ── Events / uptime ────────────────────────────────────────────────────
async function loadEvents() {
  try {
    const [evs, ut] = await Promise.all([
      api('/api/events?limit=200'),
      api('/api/uptime'),
    ]);
    renderUptimeStatus(ut);
    renderEvents(evs.items || []);
  } catch (e) { console.error(e); }
}

function renderUptimeStatus(u) {
  const el = $('uptimeStatus');
  if (!u?.heartbeat) { el.innerHTML = '<span style="color:var(--muted)">heartbeat 情報なし</span>'; return; }
  const h = u.heartbeat;
  const startedAt = h.server_started_at ? new Date(h.server_started_at) : null;
  const lastHb = h.last_heartbeat_at ? new Date(h.last_heartbeat_at) : null;
  const upMs = startedAt ? Date.now() - startedAt.getTime() : 0;
  el.innerHTML = `
    <span><b>稼働中</b> · 起動 ${startedAt ? startedAt.toLocaleString() : '?'} (${fmtElapsed(upMs)})</span>
    <span style="margin-left:12px;color:var(--muted)">last heartbeat ${lastHb ? lastHb.toLocaleTimeString() : '?'}</span>
  `;
}

const EVENT_LABELS = {
  start: '🟢 起動',
  stop: '🛑 停止 (graceful)',
  downtime: '⚠ サーバ停止 (5 分超)',
  restart: '🔁 再起動 (5 分以内)',
};

function renderEvents(items) {
  const el = $('eventsList');
  if (!items.length) { el.innerHTML = '<li class="queue-empty">イベント記録なし</li>'; return; }
  el.innerHTML = items.map(e => {
    const label = EVENT_LABELS[e.type] || e.type;
    const occ = (e.occurred_at || '').replace('T', ' ').slice(0, 19);
    const dur = e.duration_ms ? ` · ${Math.round(e.duration_ms / 1000)}秒` : '';
    const ended = e.ended_at ? ` → ${e.ended_at.replace('T',' ').slice(0,19)}` : '';
    const det = e.details ? `<div class="ev-det">${escapeHtml(JSON.stringify(e.details))}</div>` : '';
    return `<li class="ev-row ev-${e.type}">
      <span class="ev-tag">${label}</span>
      <span class="ev-time">${escapeHtml(occ)}${ended}${dur}</span>
      ${det}
    </li>`;
  }).join('');
}

document.getElementById('eventsRefresh')?.addEventListener('click', loadEvents);

// ── 🌐 Multi (Memoria Hub) browse ─────────────────────────────────────────
state.multiSubtab = 'bookmarks';

function refreshMultiTabVisibility() {
  const visible = !!state.multi?.connected;
  document.querySelectorAll('.tab-multi-only').forEach(t => { t.hidden = !visible; });
  if (!visible && state.tab === 'multi') switchTab('bookmarks');
  if (visible) {
    const badge = $('multiUserBadge');
    if (badge) badge.textContent = `🌐 ${state.multi.user.name} (${state.multi.user.role})`;
  }
  const role = state.multi?.user?.role;
  const isMod = role === 'admin' || role === 'moderator';
  document.querySelectorAll('.multi-mod-only').forEach(t => { t.hidden = !(visible && isMod); });
}

function isCurrentUserModerator() {
  const role = state.multi?.user?.role;
  return role === 'admin' || role === 'moderator';
}

async function loadMulti() {
  refreshMultiTabVisibility();
  if (!state.multi?.connected) {
    $('multiList').innerHTML = '<div class="queue-empty">マルチサーバに接続されていません。⚙ AI から接続してください。</div>';
    return;
  }
  const sub = state.multiSubtab;
  document.querySelectorAll('.multi-subtab').forEach(b => {
    b.classList.toggle('active', b.dataset.mtab === sub);
  });
  if (sub === 'moderation') {
    return loadModeration();
  }
  let url;
  if (sub === 'bookmarks') url = '/api/multi/proxy/api/shared/bookmarks?limit=50';
  else if (sub === 'digs') url = '/api/multi/proxy/api/shared/digs?limit=50';
  else url = '/api/multi/proxy/api/shared/dictionary?limit=200';
  let data;
  try { data = await api(url); }
  catch (e) {
    $('multiList').innerHTML = `<div class="queue-empty">取得失敗: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const items = data.items || [];
  if (!items.length) {
    $('multiList').innerHTML = '<div class="queue-empty">該当エントリなし</div>';
    return;
  }
  if (sub === 'bookmarks') $('multiList').innerHTML = items.map(renderMultiBookmark).join('');
  else if (sub === 'digs') $('multiList').innerHTML = items.map(renderMultiDig).join('');
  else $('multiList').innerHTML = items.map(renderMultiDict).join('');
  $('multiList').querySelectorAll('[data-download]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.download;
      const id = Number(btn.dataset.id);
      btn.disabled = true;
      btn.textContent = '取込中…';
      try {
        await api('/api/multi/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, remote_id: id }),
        });
        btn.textContent = '✓ 取込済';
      } catch (e) {
        btn.textContent = `✗ ${e.message}`;
        btn.disabled = false;
      }
    });
  });
  $('multiList').querySelectorAll('[data-hide]').forEach(btn => {
    btn.addEventListener('click', () => moderate('hide', btn.dataset.hide, Number(btn.dataset.id)));
  });
}

async function moderate(action, kind, id) {
  if (action === 'hide') {
    const reason = prompt('非表示にする理由 (任意):') ?? '';
    if (reason === null) return;
    try {
      await api('/api/multi/proxy/api/shared/moderation/hide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, id, reason }),
      });
      showShareToast('🛡 非表示にしました');
      loadMulti();
    } catch (e) { alert(`失敗: ${e.message}`); }
    return;
  }
  if (action === 'unhide') {
    try {
      await api('/api/multi/proxy/api/shared/moderation/unhide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, id }),
      });
      showShareToast('✓ 復元しました');
      loadModeration();
    } catch (e) { alert(`失敗: ${e.message}`); }
  }
}

async function loadModeration() {
  if (!isCurrentUserModerator()) {
    $('multiList').innerHTML = '<div class="queue-empty">モデレーション権限がありません</div>';
    return;
  }
  let hidden, log;
  try {
    [hidden, log] = await Promise.all([
      api('/api/multi/proxy/api/shared/moderation/hidden?limit=100'),
      api('/api/multi/proxy/api/shared/moderation/log?limit=100'),
    ]);
  } catch (e) {
    $('multiList').innerHTML = `<div class="queue-empty">取得失敗: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const hiddenItems = hidden.items || [];
  const logItems = log.items || [];
  $('multiList').innerHTML = `
    <h3 class="mod-h">非表示中 (${hiddenItems.length})</h3>
    ${hiddenItems.length === 0 ? '<div class="queue-empty">非表示エントリなし</div>'
      : hiddenItems.map(i => `<div class="multi-card mod-hidden-card">
          <div class="title">${KIND_LABEL[i.kind] || i.kind} — ${escapeHtml(i.label || `id=${i.id}`)}</div>
          <div class="multi-meta">
            <span>owner: ${escapeHtml(i.owner_user_name || i.owner_user_id)}</span>
            <span>hidden ${fmtDate(i.hidden_at)} by ${escapeHtml(i.hidden_by || '?')}</span>
            ${i.hidden_reason ? `<span>${escapeHtml(i.hidden_reason)}</span>` : ''}
            <button class="ghost ghost-sm" data-unhide="${i.kind}" data-id="${i.id}">↺ 復元</button>
          </div>
        </div>`).join('')}
    <h3 class="mod-h">監査ログ (最新 ${logItems.length})</h3>
    <ul class="mod-log">
      ${logItems.map(e => `<li>
        <span class="mono">${escapeHtml(e.occurred_at)}</span>
        <b>${escapeHtml(e.action)}</b> ${escapeHtml(e.resource_kind)}#${e.resource_id}
        by ${escapeHtml(e.acting_user_id)}
        ${e.details_json ? `<span class="mod-det">${escapeHtml(JSON.stringify(e.details_json))}</span>` : ''}
      </li>`).join('')}
    </ul>
  `;
  $('multiList').querySelectorAll('[data-unhide]').forEach(btn => {
    btn.addEventListener('click', () => moderate('unhide', btn.dataset.unhide, Number(btn.dataset.id)));
  });
}

const KIND_LABEL = { bookmark: '📑', dig: '⛏', dict: '📖' };

function modHideButton(kind, id) {
  return isCurrentUserModerator()
    ? `<button class="ghost ghost-sm danger" data-hide="${kind}" data-id="${id}">🛡 非表示</button>`
    : '';
}

function renderMultiBookmark(b) {
  return `<div class="multi-card">
    <div class="title">${escapeHtml(b.title || b.url)}</div>
    <div class="url"><a href="${escapeHtml(b.url)}" target="_blank" rel="noreferrer">${escapeHtml(b.url)}</a></div>
    ${b.summary ? `<div class="summary">${escapeHtml(b.summary)}</div>` : ''}
    <div class="cats">${(b.categories || []).map(c => `<span class="cat">${escapeHtml(c)}</span>`).join('')}</div>
    <div class="multi-meta">
      <span>by ${escapeHtml(b.owner_user_name || b.owner_user_id || '?')}</span>
      <span>${fmtDate(b.shared_at)}</span>
      <button class="ghost ghost-sm" data-download="bookmark" data-id="${b.id}">📥 ローカルへ取込</button>
      ${modHideButton('bookmark', b.id)}
    </div>
  </div>`;
}

function renderMultiDig(d) {
  const r = d.result_json || d.result || {};
  const summary = (r.summary || '').slice(0, 600);
  return `<div class="multi-card">
    <div class="title">⛏ ${escapeHtml(d.query)}</div>
    ${summary ? `<div class="summary">${escapeHtml(summary)}</div>` : ''}
    <div class="multi-meta">
      <span>by ${escapeHtml(d.owner_user_name || d.owner_user_id || '?')}</span>
      <span>${fmtDate(d.shared_at)}</span>
      <button class="ghost ghost-sm" data-download="dig" data-id="${d.id}">📥 ローカルへ取込</button>
      ${modHideButton('dig', d.id)}
    </div>
  </div>`;
}

function renderMultiDict(e) {
  return `<div class="multi-card">
    <div class="title">📖 ${escapeHtml(e.term)}</div>
    ${e.definition ? `<div class="summary">${escapeHtml(e.definition)}</div>` : ''}
    <div class="multi-meta">
      <span>by ${escapeHtml(e.owner_user_name || e.owner_user_id || '?')}</span>
      <span>${fmtDate(e.shared_at)}</span>
      <button class="ghost ghost-sm" data-download="dict" data-id="${e.id}">📥 ローカルへ取込</button>
      ${modHideButton('dict', e.id)}
    </div>
  </div>`;
}

document.querySelectorAll('.multi-subtab').forEach(b => {
  b.addEventListener('click', () => {
    state.multiSubtab = b.dataset.mtab;
    loadMulti();
  });
});
document.getElementById('multiRefresh')?.addEventListener('click', loadMulti);

// First paint: surface the multi tab if we're already connected.
refreshMultiTabVisibility();

// ── PWA share_target landing ───────────────────────────────────────────────
// /share redirects back here with ?share=ok&u=<url> after queueing the save.
(function pwaShareToast() {
  const params = new URLSearchParams(location.search);
  const flag = params.get('share');
  if (!flag) return;
  const u = params.get('u') || '';
  const div = document.createElement('div');
  div.className = 'share-toast';
  div.textContent = flag === 'ok'
    ? `📌 「${u}」を保存しました`
    : '⚠ 共有された URL を解釈できませんでした';
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 4000);
  // Strip the query so reload doesn't re-show the toast.
  history.replaceState({}, '', location.pathname);
})();

