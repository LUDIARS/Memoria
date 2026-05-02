const BOOKMARKS_PAGE_SIZE = 50;

const state = {
  bookmarks: [],
  bookmarksTotal: 0,
  categories: [],
  category: null,
  selected: new Set(),
  detailId: null,
  search: '',
  searchDebounce: null,
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
  digTheme: '',           // 現在選んでいるテーマ ('' = 全部)
  digThemes: [],          // GET /api/dig/themes の結果
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

async function load(opts = {}) {
  // 50 件ずつのページング。 「もっと表示」 で append=true、 それ以外
  // (カテゴリ切替 / ソート変更 / 検索 / 自動 refresh) は先頭から取り直す。
  const append = opts.append === true;
  const offset = append ? state.bookmarks.length : 0;
  const qs = new URLSearchParams();
  if (state.category) qs.set('category', state.category);
  if (state.sort) qs.set('sort', state.sort);
  if (state.search) qs.set('q', state.search);
  qs.set('limit', String(BOOKMARKS_PAGE_SIZE));
  qs.set('offset', String(offset));
  const [bookmarksRes, categoriesRes] = await Promise.all([
    api(`/api/bookmarks?${qs.toString()}`),
    api('/api/categories'),
  ]);
  state.bookmarks = append
    ? [...state.bookmarks, ...(bookmarksRes.items || [])]
    : (bookmarksRes.items || []);
  state.bookmarksTotal = Number.isFinite(bookmarksRes.total)
    ? bookmarksRes.total
    : state.bookmarks.length;
  state.categories = categoriesRes.items;
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
  // Use the server-reported total (across the whole DB) rather than
  // `state.bookmarks.length` which is just the current page (≤ 50).
  const total = state.bookmarksTotal;
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
  // Search filtering now happens server-side (?q=...). The full page is
  // already what we want to render — no local re-filtering.
  const items = state.bookmarks;
  renderBookmarksMore();
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

function renderBookmarksMore() {
  // The "もっと表示" button at the bottom of the card grid. Visible only
  // when the server says there are more rows than we've loaded so far.
  const btn = $('bookmarksMore');
  const status = $('bookmarksMoreStatus');
  if (!btn) return;
  const loaded = state.bookmarks.length;
  const total = state.bookmarksTotal;
  const remaining = Math.max(0, total - loaded);
  if (status) {
    status.textContent = total > 0
      ? `${loaded} / ${total} 件表示中`
      : '';
  }
  if (remaining > 0) {
    btn.hidden = false;
    btn.disabled = false;
    btn.textContent = `もっと表示 (残り ${remaining} 件)`;
  } else {
    btn.hidden = true;
  }
}

async function loadMoreBookmarks() {
  const btn = $('bookmarksMore');
  if (btn) { btn.disabled = true; btn.textContent = '読み込み中…'; }
  try {
    await load({ append: true });
  } catch (e) {
    alert(`追加読み込み失敗: ${e.message}`);
    if (btn) btn.disabled = false;
  }
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
    w.addEventListener('click', (ev) => {
      openWordRingMenu(w.dataset.word, ev.clientX, ev.clientY, { onDig: () => onCloudWordClick(w.dataset.word) });
    });
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
  // Search is now server-side (?q=) so each keystroke triggers a fetch.
  // Debounce by 250ms — long enough to skip "in-flight typing" but short
  // enough that the result list feels live.
  state.search = e.target.value;
  if (state.searchDebounce) clearTimeout(state.searchDebounce);
  state.searchDebounce = setTimeout(() => load(), 250);
});
$('sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  load();
});
$('bookmarksMore')?.addEventListener('click', () => loadMoreBookmarks());
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
  meal:      '🍽 食事解析',
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
  if (item.meal_id != null) return `${kindHint}meal #${item.meal_id}`;
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
  $('tracksView')?.classList.toggle('hidden', tab !== 'tracks');
  $('mealsView')?.classList.toggle('hidden', tab !== 'meals');
  $('externalView')?.classList.toggle('hidden', tab !== 'external');
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
  if (tab === 'tracks') loadTracks();
  if (tab === 'meals') loadMeals();
  if (tab === 'external') loadExternalConfig();
  if (tab === 'multi') loadMulti();
  bumpTabUsage(tab);
  closeTabMoreMenu();
  reflowTabsForViewport();
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
// 既定の表示優先度。 履歴が空 (= 新規ユーザ / localStorage クリア直後) の時は
// この順で上位 4 件が strip に出る。 何かを 1 度でも触れば実 usage が必ず勝つ
// よう、 default score は 1 click 未満に収めている。
const TAB_DEFAULT_PRIORITY = [
  'bookmarks', 'dig', 'diary', 'tracks', 'dict', 'domain',
  'visits', 'trends', 'recommend', 'queue', 'events', 'multi',
];
function tabDefaultScore(name) {
  const idx = TAB_DEFAULT_PRIORITY.indexOf(name);
  if (idx < 0) return 0;
  return (TAB_DEFAULT_PRIORITY.length - idx) / 1000;  // 0.001 〜 0.012
}
function tabsInUsageOrder() {
  const tabs = [...document.querySelectorAll('.tabs-scroll .tab[data-tab]')];
  const u = readTabUsage();
  return tabs.slice().sort((a, b) => {
    const sa = (u[a.dataset.tab] || 0) + tabDefaultScore(a.dataset.tab);
    const sb = (u[b.dataset.tab] || 0) + tabDefaultScore(b.dataset.tab);
    return sb - sa;
  });
}
// Mobile tab nav is "top 4 most-used + ⋯ More". active は必ず strip に
// 表示される。 More から選択したタブは promote されて leftmost に来る
// (= 旧 4 位を More に押し出す)。
const TABS_VISIBLE_ON_MOBILE = 4;

/// More メニューから選ばれたタブを strip の 1 番左に持ってくる。
/// 仕組みは「現状の最大 usage + 1 を割り当てる」 ことで、 既存の usage 並び
/// では誰よりも上に来る。 通常の strip クリックは bumpTabUsage で +1 され
/// るので、 promoted タブは新しい promote が起きるまで leftmost を保つ。
function promoteTabToTop(tab) {
  const u = readTabUsage();
  let max = 0;
  for (const v of Object.values(u)) {
    if (typeof v === 'number' && v > max) max = v;
  }
  u[tab] = max + 1;
  try { localStorage.setItem(TAB_USAGE_KEY, JSON.stringify(u)); } catch {}
}

function isNarrowViewport() {
  return window.innerWidth <= 760;
}

function closeTabMoreMenu() {
  const m = $('tabMoreMenu');
  const b = $('tabMoreBtn');
  if (m) m.hidden = true;
  if (b) b.setAttribute('aria-expanded', 'false');
}

function positionTabMoreMenu() {
  const btn = $('tabMoreBtn');
  const menu = $('tabMoreMenu');
  if (!btn || !menu || menu.hidden) return;
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth || 200;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${left}px`;
}

function openTabMoreMenu() {
  const btn = $('tabMoreBtn');
  const menu = $('tabMoreMenu');
  if (!btn || !menu) return;
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  positionTabMoreMenu();
}

function reflowTabsForViewport() {
  const scroll = document.querySelector('.tabs-scroll');
  const moreBtn = $('tabMoreBtn');
  const moreMenu = $('tabMoreMenu');
  if (!scroll || !moreBtn || !moreMenu) return;

  const allTabs = [...scroll.querySelectorAll('.tab[data-tab]')];
  // Reset every state.
  for (const t of allTabs) t.style.display = '';
  moreMenu.replaceChildren();

  // PC は data-full ラベル、 narrow viewport (mobile) は data-short ラベルへ
  // 切り替える。 機能タブの正式名称を PC で短縮しないというユーザー指示に対応。
  const narrow = isNarrowViewport();
  for (const lbl of scroll.querySelectorAll('.tab-label')) {
    const full = lbl.dataset.full ?? lbl.textContent;
    const short = lbl.dataset.short ?? full;
    lbl.textContent = narrow ? short : full;
  }

  if (!isNarrowViewport()) {
    moreBtn.hidden = true;
    moreMenu.hidden = true;
    return;
  }

  // 上位 N 件 (使用回数 + default priority) を strip に残す。 active は必ず
  // 含めるが、 圏外なら N 件目を 1 件抜いて active と入れ替える。
  // → strip 内のタブは常に最大 N 件で、 「More」 を押せば残りが見える。
  const active = state.tab;
  const ordered = tabsInUsageOrder()
    .filter(t => !t.hidden);          // skip hidden tabs (e.g. multi)
  const top = ordered.slice(0, TABS_VISIBLE_ON_MOBILE);
  const visible = new Set(top.map(t => t.dataset.tab));
  if (active && !visible.has(active)) {
    if (top.length >= TABS_VISIBLE_ON_MOBILE) {
      visible.delete(top[top.length - 1].dataset.tab);
    }
    visible.add(active);
  }

  let overflowCount = 0;
  for (const t of allTabs) {
    if (t.hidden) {
      // tab-multi-only stays out of both strip and menu when not connected.
      continue;
    }
    if (visible.has(t.dataset.tab)) {
      t.style.display = '';
    } else {
      const li = document.createElement('li');
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'tab' + (t.dataset.tab === active ? ' active' : '');
      item.dataset.tab = t.dataset.tab;
      // Strip child counts from the cloned label so the menu reads cleanly.
      item.textContent = (t.textContent || t.dataset.tab).replace(/\s+/g, ' ').trim();
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // More から選んだタブは leftmost に promote。 reflow 時にこのタブが
        // top-4 のトップに来て、 旧 4 位の機能が More に押し出される。
        promoteTabToTop(t.dataset.tab);
        switchTab(t.dataset.tab);
        closeTabMoreMenu();
      });
      li.appendChild(item);
      moreMenu.appendChild(li);
      t.style.display = 'none';
      overflowCount += 1;
    }
  }
  moreBtn.hidden = overflowCount === 0;
}

// ── Dig (deep research) ──────────────────────────────────────────────────
//
// テーマドリブン:
//  - state.digTheme: 現在選んでいるテーマ ('' = 全部)
//  - 左のテーマペインはセッションが付いたテーマを最新順に並べる
//  - 「ディグる」 押下時、 state.digTheme があればそれを引き継ぐ。 無ければ
//    バックエンドが query から自動で導出してくれる。

async function loadDigHistory() {
  try {
    const qs = state.digTheme ? `?theme=${encodeURIComponent(state.digTheme)}` : '';
    const { items } = await api(`/api/dig${qs}`);
    state.digHistory = items;
    renderDigHistory();
    if (!state.digEnginesLoaded) loadDigEngines();
    loadDigThemes();
  } catch (e) { console.error(e); }
}

async function loadDigThemes() {
  try {
    const { items } = await api('/api/dig/themes');
    state.digThemes = items;
    renderDigThemes();
  } catch (e) { console.error(e); }
}

function renderDigThemes() {
  const list = $('digThemeList');
  if (!list) return;
  // Build the "全部" first item, then one per theme.
  const totalCount = state.digThemes
    ? state.digThemes.reduce((acc, t) => acc + (t.session_count || 0), 0)
    : 0;
  const themes = state.digThemes || [];
  const items = [
    `<li class="dig-theme-item ${state.digTheme ? '' : 'active'}" data-theme="">
       <span class="theme-name">全部</span>
       <span class="count">${totalCount || ''}</span>
     </li>`,
    ...themes.map(t => {
      const active = state.digTheme === t.theme ? 'active' : '';
      return `<li class="dig-theme-item ${active}" data-theme="${escapeHtml(t.theme)}"
                  title="${escapeHtml(t.last_query || '')}\n最終: ${escapeHtml(t.last_at || '')}">
        <span class="theme-name">${escapeHtml(t.theme)}</span>
        <span class="count">${t.session_count}</span>
      </li>`;
    }),
  ];
  list.innerHTML = items.join('');
  list.querySelectorAll('.dig-theme-item').forEach(li => {
    li.addEventListener('click', () => {
      state.digTheme = li.dataset.theme || '';
      // Theme 切替で履歴 + バッジ + 結果ペインをクリア
      state.digSession = null;
      state.digSelected = new Set();
      const result = $('digResult');
      if (result) result.innerHTML = '';
      renderDigThemeBadge();
      renderDigThemes();
      loadDigHistory();
    });
  });
}

function renderDigThemeBadge() {
  const badge = $('digThemeBadge');
  if (!badge) return;
  if (state.digTheme) {
    badge.hidden = false;
    badge.innerHTML = `<span class="dig-theme-badge-label">テーマ:</span>
      <strong>${escapeHtml(state.digTheme)}</strong>
      <button id="digThemeBadgeClear" class="ghost" title="テーマ選択を解除">×</button>`;
    badge.querySelector('#digThemeBadgeClear')?.addEventListener('click', () => {
      state.digTheme = '';
      renderDigThemeBadge();
      renderDigThemes();
      loadDigHistory();
    });
  } else {
    badge.hidden = true;
    badge.innerHTML = '';
  }
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
    const msg = state.digTheme
      ? `テーマ "${escapeHtml(state.digTheme)}" のディグなし`
      : '過去のディグなし';
    el.innerHTML = `<div class="dig-history-empty">${msg}</div>`;
    return;
  }
  // 過去のディグはリスト形式 (タイトル付き ul)。 クリックで該当セッションを開く。
  // 旧 pill strip は短すぎてクエリ全文が見えなかったので置き換え。
  el.innerHTML = `
    <div class="dig-history-h">過去のディグ (${state.digHistory.length} 件)</div>
    <ul class="dig-history-list">
      ${state.digHistory.map(s => {
        const active = state.digSession?.id === s.id ? ' active' : '';
        const themeChip = s.theme ? `<span class="theme">${escapeHtml(s.theme)}</span>` : '';
        return `
          <li class="dig-history-item ${s.status}${active}" data-id="${s.id}">
            <span class="status-dot ${s.status}" title="${escapeHtml(s.status)}"></span>
            <span class="query">${escapeHtml(s.query)}</span>
            ${themeChip}
            <span class="time">${escapeHtml(formatDigTime(s.created_at))}</span>
            <button type="button" class="dig-history-del" title="この誤 Dig を削除">×</button>
          </li>
        `;
      }).join('')}
    </ul>
  `;
  el.querySelectorAll('.dig-history-item').forEach(li => {
    li.addEventListener('click', (e) => {
      // delete ボタンは行クリック扱いしない (loadDigSession を抑止)。
      if (e.target.closest('.dig-history-del')) return;
      loadDigSession(Number(li.dataset.id));
    });
    const delBtn = li.querySelector('.dig-history-del');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number(li.dataset.id);
        const item = state.digHistory.find(h => h.id === id);
        const queryLabel = (item?.query || '').slice(0, 60);
        if (!confirm(`このディグを削除しますか?\n「${queryLabel}」`)) return;
        await deleteDigSessionFromUi(id);
      });
    }
  });
}

async function deleteDigSessionFromUi(id) {
  try {
    await api(`/api/dig/${id}`, { method: 'DELETE' });
  } catch (e) {
    alert(`削除失敗: ${e.message}`);
    return;
  }
  // 表示中のセッションだったら結果ペインも閉じる + ポーリングを止める。
  if (state.digSession?.id === id) {
    if (state.digPolling) { clearInterval(state.digPolling); state.digPolling = null; }
    state.digSession = null;
    state.digSelected = new Set();
    const el = $('digResult');
    if (el) el.innerHTML = '';
    const shareBar = $('digShareBar');
    if (shareBar) shareBar.hidden = true;
  }
  await loadDigHistory();
  // テーマペインの件数表示も更新 (最後の 1 件を消したらテーマも消える)。
  loadDigThemes().catch(() => {});
}

function formatDigTime(ts) {
  if (!ts) return '';
  // SQLite stores as 'YYYY-MM-DD HH:MM:SS' UTC. Parse-as-UTC, format local MM/DD HH:MM.
  const iso = String(ts).replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(ts) ? '' : 'Z');
  const d = new Date(iso);
  if (isNaN(d.getTime())) return ts;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

async function startDig({ chainCloudId, chainParentWord, forceNewTheme } = {}) {
  const q = $('digQuery').value.trim();
  if (!q) return;
  // ディグ開始と同時に textarea / pick-hint を空にする (ユーザ指示)。 過去の
  // クエリは下のリストで参照できる。
  $('digQuery').value = '';
  clearDigPick();
  const runBtn = $('digRun');
  const newBtn = $('digRunNewTheme');
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = '掘削中…'; }
  if (newBtn) newBtn.disabled = true;
  try {
    const engineSel = $('digEngine');
    const search_engine = engineSel ? engineSel.value : 'default';
    // 通常: 現在テーマを引き継ぐ。 forceNewTheme なら theme を渡さず、
    // バックエンドに deriveDigTheme(query) で新規テーマを起こさせる。
    const body = { query: q, search_engine };
    if (!forceNewTheme && state.digTheme) body.theme = state.digTheme;
    const r = await api('/api/dig', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    state.digChain = {
      cloudId: chainCloudId ?? null,
      parentWord: chainParentWord ?? null,
    };
    // 新規 dig が落ち着いたテーマがあれば、 それを current として引き継ぐ。
    // forceNewTheme の場合は backend が新規テーマを返してくるので state を
    // それに切り替える。
    if (r.theme && (forceNewTheme || !state.digTheme)) {
      state.digTheme = r.theme;
      renderDigThemeBadge();
    }
    await loadDigHistory();
    pollDigSession(r.id);
  } catch (e) {
    alert(`dig 失敗: ${e.message}`);
  } finally {
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = '🔎 ディグる'; }
    if (newBtn) newBtn.disabled = false;
  }
}

/**
 * ノードクリック時のワンクッション。 textarea にプロンプトを下書きして
 * フォーカスを移し、 ユーザに 「○○ について何を知りたいか?」 を書き足して
 * もらう。 「ディグる」 でテーマ内深堀、 「別テーマとして検索」 で新規テーマ。
 */
function digOnWordPick(session, word) {
  state.digPickedWord = word;
  const ta = $('digQuery');
  if (!ta) return;
  // 既に何か書きかけならスペース区切りで継ぎ足す。 空なら「<word> について 」。
  const prefix = ta.value.trim() ? `${ta.value.trim()} ${word} ` : `${word} について `;
  ta.value = prefix;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  // ヒント帯 (textarea 直上) を表示。
  const hint = $('digPickHint');
  if (hint) {
    const themeLabel = session?.theme || state.digTheme || '';
    const themeHint = themeLabel ? `テーマ「${themeLabel}」内` : '同じテーマ';
    hint.querySelector('.dig-pick-text').textContent =
      `「${word}」 について何を知りたい? ${themeHint}で深堀する場合は ディグる、 別テーマで検索する場合は 別テーマとして検索 を押してください。`;
    hint.hidden = false;
  }
  // 軽くスクロール: textarea が見えるように。
  ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearDigPick() {
  state.digPickedWord = null;
  const hint = $('digPickHint');
  if (hint) {
    hint.hidden = true;
    const tx = hint.querySelector('.dig-pick-text');
    if (tx) tx.textContent = '';
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
    // Show whatever we have RIGHT NOW. Three layers in increasing latency:
    //   raw_results (no AI, ~2 s)  →  preview (AI overview, ~30 s)  →
    //   full result (deep AI dig, minutes).
    const layers = [];
    if (s.raw_results) layers.push(renderDigRawResults(s));
    if (s.preview) layers.push(renderDigPreview(s));
    const tail = s.preview
      ? '詳細解析を続行中…完了するとさらに整理された結果が表示されます。'
      : (s.raw_results
        ? 'AI overview を取得中…続けて詳細解析が走ります。'
        : `「${escapeHtml(s.query)}」を検索中…数秒で生の検索結果、その後に AI 解析が来ます。`);
    el.innerHTML = layers.join('') + `<div class="dig-pending dig-pending-tight"><div class="pulse"></div>${escapeHtml(tail)}</div>`;
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
  const graph = sources.length > 0 ? digWordCloud(s, sources) : '';
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
      <button id="digDeleteBtn" class="danger" title="この誤 Dig を削除">🗑 削除</button>
      <button id="digSaveBtn">選択をブックマーク化</button>
    </div>
    <div class="dig-sources">${sourceCards}</div>
  `;
  // Cloud node clicks — explored word はその過去 session へジャンプ。
  // それ以外は単語リングメニューを開いて 「ディグる / 辞書登録 / 削除」
  // を選ばせる (one-cushion 廃止、 明示的な分岐に)。
  const handleNodeClick = (target, ev) => {
    const exploredId = target.dataset.exploredId;
    if (exploredId) {
      loadDigSession(Number(exploredId));
      return;
    }
    const word = target.dataset.word;
    if (!word) return;
    openWordRingMenu(word, ev?.clientX, ev?.clientY, { session: s });
  };
  el.querySelectorAll('.dig-graph-node, .dig-cloud-word').forEach(node => {
    node.addEventListener('click', (ev) => handleNodeClick(node, ev));
  });
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
  $('digDeleteBtn')?.addEventListener('click', async () => {
    const queryLabel = (s.query || '').slice(0, 60);
    if (!confirm(`このディグを削除しますか?\n「${queryLabel}」`)) return;
    await deleteDigSessionFromUi(s.id);
  });
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

// Stopwords for the inline dig word cloud — mirror of server/db.js
// `KEYWORD_STOPWORDS` plus a few search-result chrome words ("article",
// "page" 等) we don't want surfacing as "key terms".
const DIG_CLOUD_STOPWORDS = new Set([
  'the','and','for','with','from','that','this','your','you','our','have','has','was','were','will',
  'what','when','where','which','who','about','into','than','then','also','but','not','are','can',
  'use','using','how','why','etc','its','their','they','there','here','been','being','one','two',
  'more','most','some','any','all','out','off','per','via','new','old','top','best','vs',
  'http','https','www','com','net','org','jp','html','htm','php','asp',
  'について','として','による','によって','などの','する','して','です','ます','ない','ある','こと',
  'もの','よう','これ','それ','ため','など','とは','では','での','さん','さま','様','記事','ページ',
  'こちら','そして','しかし','ただし','ここ','以下','以上','について','詳しく','一覧','まとめ',
]);

// Upper bounds for "is this still a word, not a sentence?". A CJK run that's
// 13 chars long is almost always a phrase (e.g. 「機械学習による画像分類」),
// not a single term. Same for very long latin runs — usually URL fragments
// or run-on text from a snippet that lost its delimiters.
const DIG_CLOUD_MAX_ASCII_LEN = 24;
const DIG_CLOUD_MAX_CJK_LEN   = 12;

/**
 * Tokenise a blob of text into a frequency map of "key" words.
 *  - ASCII / Latin: ≥ 3 chars, ≤ DIG_CLOUD_MAX_ASCII_LEN.
 *  - CJK (kana, hiragana, katakana, kanji): runs ≥ 2 chars,
 *    ≤ DIG_CLOUD_MAX_CJK_LEN.
 *
 * Returns a Map<lowercaseKey, count>. Stopwords (English filler + Japanese
 * filler) are dropped, and overly long runs are dropped as "this is a
 * sentence, not a word".
 *
 * For shape classification we also need the ORIGINAL casing of each ASCII
 * token (lowercased "webgpu" loses the ProperCase signal). Use
 * `digCloudOriginalCase(text)` to recover that — kept as a sister fn so
 * the simple frequency case stays cheap.
 */
function digCloudTokenize(text) {
  const freq = new Map();
  for (const m of String(text || '').matchAll(/[A-Za-z][A-Za-z0-9_+#.\-]{2,}/g)) {
    const orig = m[0];
    if (orig.length > DIG_CLOUD_MAX_ASCII_LEN) continue;
    const key = orig.toLowerCase();
    if (DIG_CLOUD_STOPWORDS.has(key)) continue;
    freq.set(key, (freq.get(key) || 0) + 1);
  }
  for (const m of String(text || '').matchAll(/[぀-ヿ一-鿿]{2,}/g)) {
    const w = m[0];
    if (w.length > DIG_CLOUD_MAX_CJK_LEN) continue;
    if (DIG_CLOUD_STOPWORDS.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return freq;
}

/**
 * Build a `Map<lowercaseKey, originalForm>` for ASCII tokens — the
 * "best-looking" casing we observed (first occurrence wins). CJK tokens
 * map to themselves. Used by digCloudShape so `WebGPU` keeps its capitals
 * for the Mixed-Case heuristic.
 */
function digCloudOriginalCase(text) {
  const map = new Map();
  for (const m of String(text || '').matchAll(/[A-Za-z][A-Za-z0-9_+#.\-]{2,}/g)) {
    const orig = m[0];
    if (orig.length > DIG_CLOUD_MAX_ASCII_LEN) continue;
    const key = orig.toLowerCase();
    if (!map.has(key)) map.set(key, orig);
  }
  for (const m of String(text || '').matchAll(/[぀-ヿ一-鿿]{2,}/g)) {
    const w = m[0];
    if (w.length > DIG_CLOUD_MAX_CJK_LEN) continue;
    if (!map.has(w)) map.set(w, w);
  }
  return map;
}

/**
 * Classify a token into 'circle' (abstract / domain term) or 'square'
 * (concrete entity — product, brand, version, identifier).
 *
 * Heuristic: anything that looks proper-noun-shaped is concrete.
 *   - has a digit                         → square (versions, IDs)
 *   - mixed case English (CamelCase)      → square (product names)
 *   - all-caps acronym (≥ 2 chars)        → square (DRY, GPU, …)
 *   - katakana-dominant short run (≤ 6)   → square (ブランド名 / 製品名)
 *   - everything else                     → circle (general concept)
 *
 * Imperfect, but quick and stable. We deliberately avoid an LLM call
 * here — the user wants the graph to render instantly with the dig.
 */
function digCloudShape(word) {
  if (!word) return 'circle';
  if (/\d/.test(word)) return 'square';
  if (/[A-Z]/.test(word) && /[a-z]/.test(word)) return 'square';
  if (/^[A-Z]{2,}$/.test(word)) return 'square';
  // Pure katakana run — typically loanword-as-product/brand. Long katakana
  // (e.g. 「アーキテクチャ」) is more often a concept, so cap at 6.
  if (/^[ァ-ヿー]+$/.test(word) && word.length <= 6) return 'square';
  return 'circle';
}

/**
 * Wrap a single token across at most 2 lines so the label fits inside its
 * shape. Estimates per-char width by script (CJK ≈ font-size, ASCII ≈ 0.55
 * font-size). If 2 lines still don't fit, the second line is truncated
 * with an ellipsis — the full word remains in the tooltip / data-word.
 */
function digCloudWrap(word, fontSize, maxWidthPx) {
  if (!word) return [''];
  const isCjk = /[぀-ヿ一-鿿]/.test(word);
  const charW = isCjk ? fontSize * 1.0 : fontSize * 0.55;
  const maxChars = Math.max(2, Math.floor(maxWidthPx / charW));
  if (word.length <= maxChars) return [word];
  // Two lines max — anything more is unreadable inside a node.
  const first = word.slice(0, maxChars);
  let second = word.slice(maxChars);
  if (second.length > maxChars) second = second.slice(0, Math.max(1, maxChars - 1)) + '…';
  return [first, second];
}

/**
 * Build a word-cloud GRAPH from this dig's sources. Each node is a frequent
 * word; edge = co-occurrence within the same source's text. Replaces the
 * old text-only cloud and the even older "center + ring of domains" graph.
 *
 *  - Node font-size scales with word frequency (頻出単語ほど大きく).
 *  - Edges are drawn between words that co-occur in ≥ 2 sources, capped at
 *    the top 3 partners per node so we don't end up with a hairball.
 *  - Layout: simple force-directed simulation (~150 iter) — fine for 30
 *    nodes, no library needed.
 *  - 過去のディグに同じ語があればノードを「↪」 でマークし、クリック時の
 *    挙動を変える (one-cushion flow — see digOnWordPick callers).
 */
function digWordCloud(session, sources) {
  const TOP_N = 30;
  const sourceTokens = sources.map(s => digCloudTokenize(
    `${s.title || ''} ${s.snippet || ''} ${(s.topics || []).join(' ')}`
  ));
  const queryTokens = digCloudTokenize(session.query || '');

  // Original-case map — needed so digCloudShape can see "WebGPU" (mixed)
  // vs "design" (pure lowercase). Built from the same combined text.
  const caseMap = digCloudOriginalCase(
    sources.map(s => `${s.title || ''} ${s.snippet || ''} ${(s.topics || []).join(' ')}`).join(' ')
  );

  // Global frequency = total occurrences across all sources.
  const freq = new Map();
  for (const ft of sourceTokens) {
    for (const [w, n] of ft) freq.set(w, (freq.get(w) || 0) + n);
  }
  for (const k of queryTokens.keys()) freq.delete(k);

  const words = [...freq.entries()]
    .map(([key, count]) => ({
      key,
      word: caseMap.get(key) || key,
      count,
    }))
    .filter(w => w.count >= 2 || w.key.length >= 4)
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_N);
  if (!words.length) return '';

  // wordIndex is keyed by the lowercase token (matches what's in
  // `sourceTokens`/`queryTokens`/`pastByQuery`). Display strings live in
  // `node.word` later via `caseMap`.
  const wordIndex = new Map(words.map((w, i) => [w.key, i]));

  // Co-occurrence: for each source, every pair of present words → +1.
  const pairWeight = new Map();
  function pairKey(a, b) { return a < b ? `${a}|||${b}` : `${b}|||${a}`; }
  for (const ft of sourceTokens) {
    const present = [...ft.keys()].filter(w => wordIndex.has(w));
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const k = pairKey(present[i], present[j]);
        pairWeight.set(k, (pairWeight.get(k) || 0) + 1);
      }
    }
  }
  // Reduce to top-3 partners per node — stops the layout becoming a blob.
  const adjPicks = new Map(words.map(w => [w.key, []]));
  for (const [k, w] of pairWeight) {
    if (w < 2) continue;
    const [a, b] = k.split('|||');
    adjPicks.get(a).push({ other: b, w });
    adjPicks.get(b).push({ other: a, w });
  }
  const edges = [];
  const seenEdge = new Set();
  for (const [key, picks] of adjPicks) {
    picks.sort((x, y) => y.w - x.w);
    for (const p of picks.slice(0, 3)) {
      const k = pairKey(key, p.other);
      if (seenEdge.has(k)) continue;
      seenEdge.add(k);
      edges.push({ a: wordIndex.get(key), b: wordIndex.get(p.other), w: p.w });
    }
  }

  // Past-search index (token → most recent past session containing it).
  const pastByQuery = new Map();
  for (const h of state.digHistory || []) {
    if (!h || h.id === session.id) continue;
    for (const tok of digCloudTokenize(h.query || '').keys()) {
      if (!pastByQuery.has(tok)) pastByQuery.set(tok, h);
    }
  }

  // Force-directed simulation. The viewBox is 720x440; nodes start spread
  // around the centre, then repel/attract until shapes don't overlap.
  // Each node carries its visual width / height (computed from wrapped text)
  // and the simulation uses the half-diagonal as a collision radius — that
  // keeps both circles AND squares clear of each other.
  const W = 720, H = 440;
  const max = words[0].count;
  const NODE_PAD_X = 8;     // padding between text and shape edge (horiz)
  const NODE_PAD_Y = 6;     // padding between text and shape edge (vert)
  const MAX_TEXT_WIDTH_PX = 88;  // wrap above this; still small enough that
                                  // 30 nodes fit in 720x440 without crowding

  const nodes = words.map((w, i) => {
    const angle = (i / words.length) * Math.PI * 2;
    const fontSize = 11 + 14 * (w.count / max);   // ~11–25 px
    const past = pastByQuery.get(w.key);
    const prefix = past ? '↪ ' : '';
    const display = `${prefix}${w.word}`;
    const lines = digCloudWrap(display, fontSize, MAX_TEXT_WIDTH_PX);
    const isCjk = /[぀-ヿ一-鿿]/.test(w.word);
    const charW = isCjk ? fontSize * 1.0 : fontSize * 0.55;
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const textW = longest * charW;
    const lineH = fontSize * 1.18;
    const textH = lines.length * lineH;
    // Square nodes get a bit of extra horizontal padding so the rect
    // doesn't look squashed; circles stay tight (the circle naturally
    // wastes corner space).
    const shape = digCloudShape(w.word);
    const padX = NODE_PAD_X + (shape === 'square' ? 4 : 0);
    const padY = NODE_PAD_Y;
    const halfW = textW / 2 + padX;
    const halfH = textH / 2 + padY;
    // Collision radius = circumscribed circle around the shape's bbox.
    // For a square this slightly over-spaces vs. the visible edges, but
    // it's the simple, always-correct choice and keeps the simulation
    // stable.
    const r = Math.sqrt(halfW * halfW + halfH * halfH);
    return {
      i,
      key: w.key,
      word: w.word,
      count: w.count,
      shape,
      lines,
      fontSize,
      lineH,
      halfW, halfH, r,
      x: W / 2 + Math.cos(angle) * 120,
      y: H / 2 + Math.sin(angle) * 90,
      vx: 0, vy: 0,
    };
  });

  const SPRING = 0.012;
  const SPRING_LEN = 110;
  const CENTER_PULL = 0.0025;
  const DAMP = 0.86;
  const COLLISION_PAD = 4;       // gap in px between any two shapes
  const ITER = 240;
  for (let step = 0; step < ITER; step++) {
    for (const a of nodes) { a.fx = 0; a.fy = 0; }
    // Pairwise: hard collision push when shapes (would) overlap, plus a
    // gentle inverse-square repel beyond the collision distance so the
    // graph keeps breathing room between disconnected clusters.
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      a.fx += (W / 2 - a.x) * CENTER_PULL;
      a.fy += (H / 2 - a.y) * CENTER_PULL;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); d2 = 1; }
        const d = Math.sqrt(d2);
        const minDist = a.r + b.r + COLLISION_PAD;
        if (d < minDist) {
          // Hard separation — proportional to overlap.
          const overlap = (minDist - d);
          const push = overlap * 0.5;
          const ux = dx / d, uy = dy / d;
          a.fx += ux * push; a.fy += uy * push;
          b.fx -= ux * push; b.fy -= uy * push;
        } else {
          // Soft repel for spacing.
          const f = 600 / d2;
          const ux = dx / d, uy = dy / d;
          a.fx += ux * f; a.fy += uy * f;
          b.fx -= ux * f; b.fy -= uy * f;
        }
      }
    }
    for (const e of edges) {
      const a = nodes[e.a], b = nodes[e.b];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = SPRING * (d - SPRING_LEN) * Math.min(1, e.w / 4);
      const fxs = (dx / d) * f, fys = (dy / d) * f;
      a.fx += fxs; a.fy += fys;
      b.fx -= fxs; b.fy -= fys;
    }
    for (const a of nodes) {
      a.vx = (a.vx + a.fx) * DAMP;
      a.vy = (a.vy + a.fy) * DAMP;
      a.x += a.vx;
      a.y += a.vy;
      // Viewport clamp: shape's bounding box stays inside the SVG.
      if (a.x - a.halfW < 2)        { a.x = 2 + a.halfW;       a.vx = 0; }
      if (a.x + a.halfW > W - 2)    { a.x = W - 2 - a.halfW;   a.vx = 0; }
      if (a.y - a.halfH < 2)        { a.y = 2 + a.halfH;       a.vy = 0; }
      if (a.y + a.halfH > H - 2)    { a.y = H - 2 - a.halfH;   a.vy = 0; }
    }
  }

  // Render edges first (under nodes).
  const maxEdgeW = edges.reduce((m, e) => Math.max(m, e.w), 1);
  const edgeSvg = edges.map(e => {
    const a = nodes[e.a], b = nodes[e.b];
    const opacity = 0.18 + 0.6 * (e.w / maxEdgeW);
    const stroke = (1 + 2 * (e.w / maxEdgeW)).toFixed(1);
    return `<line class="dig-graph-edge" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke-width="${stroke}" opacity="${opacity.toFixed(2)}" />`;
  }).join('');

  const nodeSvg = nodes.map(n => {
    const past = pastByQuery.get(n.key);
    const cls = `dig-graph-node ${n.shape === 'square' ? 'shape-square' : 'shape-circle'}${past ? ' explored' : ''}`;
    const titleAttr = past
      ? `過去のディグ「${past.query}」に連結 — クリックでそのセッションへ`
      : `${n.count} 回出現 (${n.shape === 'square' ? '具体' : '抽象'}) — クリックで深堀の入力欄へ送る`;
    const dataAttr = past
      ? `data-explored-id="${past.id}"`
      : `data-word="${escapeHtml(n.word)}"`;
    // Shape: circle for abstract terms, rounded square for concrete things.
    const shapeSvg = n.shape === 'square'
      ? `<rect class="dig-graph-shape"
              x="${(-n.halfW).toFixed(1)}" y="${(-n.halfH).toFixed(1)}"
              width="${(n.halfW * 2).toFixed(1)}" height="${(n.halfH * 2).toFixed(1)}"
              rx="6" ry="6" />`
      : `<ellipse class="dig-graph-shape"
              cx="0" cy="0"
              rx="${n.halfW.toFixed(1)}" ry="${n.halfH.toFixed(1)}" />`;
    // Multiline text: tspans stacked vertically, centred.
    const totalH = n.lines.length * n.lineH;
    const startY = -totalH / 2 + n.lineH / 2;
    const tspans = n.lines.map((line, idx) =>
      `<tspan x="0" y="${(startY + idx * n.lineH).toFixed(1)}">${escapeHtml(line)}</tspan>`
    ).join('');
    return `<g class="${cls}" ${dataAttr} transform="translate(${n.x.toFixed(1)},${n.y.toFixed(1)})">
      <title>${escapeHtml(titleAttr)}</title>
      ${shapeSvg}
      <text class="dig-graph-label" text-anchor="middle" dominant-baseline="middle"
            font-size="${n.fontSize.toFixed(1)}">${tspans}</text>
    </g>`;
  }).join('');

  const exploredCount = nodes.filter(n => pastByQuery.has(n.key)).length;
  const exploredHint = exploredCount
    ? `<span class="dig-cloud-explored-hint" title="↪ 印付きノードは過去のディグに連結 — クリックでそのセッションへ">↪ ${exploredCount} 語が過去ディグに連結</span>`
    : '';

  return `<div class="dig-cloud-inline">
    <div class="dig-cloud-title">関連ワードグラフ (${words.length} 語 / ${edges.length} エッジ) ${exploredHint}</div>
    <div class="dig-graph-wrap">
      <svg class="dig-graph-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        <g class="edges">${edgeSvg}</g>
        <g class="nodes">${nodeSvg}</g>
      </svg>
    </div>
  </div>`;
}

function renderDigRawResults(session) {
  // Pure-scrape SERP results (no AI). First thing the user sees after
  // pressing ディグる — usually within ~2 s of submission.
  const raw = session.raw_results || {};
  const items = (raw.results || []);
  if (!items.length) return '';
  const engineLabel = raw.engine === 'bing' ? 'Bing' : 'DuckDuckGo';
  const list = items.map(r => `
    <li class="dig-raw-result">
      <div class="title"><a href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer">${escapeHtml(r.title || r.url)}</a></div>
      <div class="url">${escapeHtml(r.domain || r.url)}</div>
      ${r.snippet ? `<div class="snippet">${escapeHtml(r.snippet)}</div>` : ''}
    </li>
  `).join('');
  return `
    <div class="dig-raw">
      <h3 class="dig-raw-h">⚡ 生の検索結果 <span class="dig-raw-tag">${escapeHtml(engineLabel)} スクレイプ — AI なし</span></h3>
      <ol class="dig-raw-list">${list}</ol>
    </div>
  `;
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
    w.addEventListener('click', (ev) => {
      openWordRingMenu(w.dataset.word, ev.clientX, ev.clientY, { onDig: () => onCloudWordClick(w.dataset.word) });
    });
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
  // ワンクッション: 即ディグらず、 textarea にプロンプトを下書きして
  // ユーザに 「○○ について何を知りたいか?」 を書き足させる。
  switchTab('dig');
  digOnWordPick({ query: c?.label || '', theme: c?.parent_word || null }, word);
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

  // Show Sonnet's inferred focused-work time as a small tag next to status.
  // Hidden when the diary hasn't run yet or Sonnet declined to estimate.
  const wmEl = $('diaryWorkMinutes');
  if (wmEl) {
    const wm = Number(d.work_minutes);
    if (Number.isFinite(wm) && wm >= 0) {
      const h = Math.floor(wm / 60);
      const m = wm % 60;
      wmEl.textContent = `推定作業 ${h}h ${m}m`;
      wmEl.hidden = false;
    } else {
      wmEl.hidden = true;
      wmEl.textContent = '';
    }
  }

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
      return `<li class="diary-domain-card">
        <div class="diary-domain-head">
          <span class="diary-domain-swatch" style="background:${color}"></span>
          <span class="diary-domain-title">${escapeHtml(display)}</span>
          ${sub}
          <span class="grow"></span>
          <span class="diary-domain-count">${dm.count} 件 · ${dm.active_hours.length} 時間帯</span>
        </div>
        ${desc}
      </li>`;
    }).join('');

  const created = metrics.bookmarks?.created || [];
  const createdTotal = metrics.bookmarks?.created_total ?? created.length;
  renderDiaryBookmarkList('diaryBookmarksCreated', created, createdTotal, 'created', '新規ブックマークなし');

  const accessed = metrics.bookmarks?.accessed || [];
  const accessedTotal = metrics.bookmarks?.accessed_total ?? accessed.length;
  renderDiaryBookmarkList('diaryBookmarksAccessed', accessed, accessedTotal, 'accessed', '再訪なし');

  const digs = metrics.digs || [];
  const digsTotal = metrics.digs_total ?? digs.length;
  renderDiaryDigList(digs, digsTotal);

  // 食事
  renderDiaryMeals(metrics.meals || [], metrics.meals_total_calories, metrics.meals_nutrients, metrics.meals_pfc_label);
  // カロリーバランス
  renderDiaryCaloricBalance(metrics.caloric_balance);

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

// ── Diary list paging helpers ─────────────────────────────────────────────

function bookmarkLi(b, withAccessCount = false) {
  const accessCount = withAccessCount && b.access_count
    ? `<span class="access-count">×${b.access_count}</span>`
    : '';
  const summary = b.summary ? `<div class="summary">${escapeHtml(String(b.summary).slice(0, 200))}</div>` : '';
  return `<li class="diary-bookmark" data-id="${b.id}">
    <a href="${escapeHtml(b.url)}" target="_blank" rel="noreferrer" class="title">${escapeHtml(b.title || b.url)}</a>
    <div class="url">${escapeHtml(b.url)} ${accessCount}</div>
    ${summary}
  </li>`;
}
function attachBookmarkClicks(scope) {
  scope.querySelectorAll('.diary-bookmark').forEach(li => {
    if (li.dataset.bound === '1') return;
    li.dataset.bound = '1';
    li.addEventListener('click', (ev) => {
      if (ev.target.tagName === 'A') return;
      const id = Number(li.dataset.id);
      switchTab('bookmarks');
      openDetail(id);
    });
  });
}

function renderDiaryBookmarkList(elId, items, total, kind, emptyMsg) {
  const ul = $(elId);
  if (!items.length) {
    ul.innerHTML = `<li class="queue-empty">${emptyMsg}</li>`;
    return;
  }
  const withAccess = kind === 'accessed';
  ul.innerHTML = items.map(b => bookmarkLi(b, withAccess)).join('');
  attachBookmarkClicks(ul);
  if (total > items.length) {
    appendDiaryMoreButton(ul, items.length, total, async (offset) => {
      const date = state.diaryDetailDate;
      const r = await api(`/api/diary/${date}/bookmarks?kind=${kind}&offset=${offset}&limit=20`);
      return { items: (r.items || []).map(b => bookmarkLi(b, withAccess)), total: r.total };
    });
  }
}

function fmtNutrient(v, unit) {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  return `${Math.round(v * 10) / 10}${unit}`;
}

function renderDiaryCaloricBalance(cb) {
  const wrap = document.getElementById('diaryCaloricBalance');
  if (!wrap) return;
  if (!cb) {
    wrap.innerHTML = `<div class="hint">プロファイルが未設定です。 設定 (右上 ⚙) → 「🧍 プロファイル」 で年齢 / 性別 / 体重 / 身長 / 活動レベルを入れると、 BMR + TDEE + 軌跡からの歩行消費を計算します。</div>`;
    return;
  }
  const p = cb.profile;
  const sexLabel = p.sex === 'male' ? '男性' : '女性';
  const intakeStr = (cb.intake != null) ? `${cb.intake} kcal` : '— (食事なし)';
  const diffT = cb.diff_vs_target;
  const diffE = cb.diff_vs_expenditure;
  const sign = (n) => n == null ? '—' : (n > 0 ? `+${n}` : String(n));
  const diffTClass = diffT == null ? '' : (diffT > 200 ? 'over' : diffT < -200 ? 'under' : 'ok');
  const diffEClass = diffE == null ? '' : (diffE > 200 ? 'over' : diffE < -200 ? 'under' : 'ok');
  wrap.innerHTML = `
    <div class="cb-profile muted">${escapeHtml(sexLabel)} / ${p.age}歳 / ${p.weight_kg}kg / ${p.height_cm}cm / 活動 ${escapeHtml(p.activity_level)}</div>
    <div class="cb-grid">
      <div class="cb-stat">
        <div class="cb-label">摂取</div>
        <div class="cb-value">${escapeHtml(intakeStr)}</div>
      </div>
      <div class="cb-stat">
        <div class="cb-label">消費 (BMR + 歩行)</div>
        <div class="cb-value">${cb.expenditure_total} kcal</div>
        <div class="cb-sub muted">BMR ${cb.bmr} + 歩行 ${cb.walking_kcal}</div>
      </div>
      <div class="cb-stat">
        <div class="cb-label">適正 (TDEE)</div>
        <div class="cb-value">${cb.tdee} kcal</div>
      </div>
      <div class="cb-stat cb-diff ${diffTClass}">
        <div class="cb-label">摂取 - 適正</div>
        <div class="cb-value">${escapeHtml(sign(diffT))} kcal</div>
      </div>
      <div class="cb-stat cb-diff ${diffEClass}">
        <div class="cb-label">摂取 - 消費 (収支)</div>
        <div class="cb-value">${escapeHtml(sign(diffE))} kcal</div>
      </div>
    </div>
  `;
}

function renderDiaryMeals(meals, totalCal, nutrients, pfcLabel) {
  const wrap = document.getElementById('diaryMeals');
  if (!wrap) return;
  if (!meals || meals.length === 0) {
    wrap.innerHTML = '<div class="queue-empty">この日の食事記録はなし</div>';
    return;
  }
  const totalLine = (typeof totalCal === 'number')
    ? `<div class="diary-meals-total">総カロリー: <strong>${totalCal} kcal</strong> (${meals.length} 食)</div>`
    : `<div class="diary-meals-total muted">${meals.length} 食 (カロリー未推定)</div>`;
  const nutLine = nutrients
    ? `<div class="diary-meals-nutrients">
        <span class="nutrient-chip"><b>P</b> ${fmtNutrient(nutrients.protein_g, 'g')}</span>
        <span class="nutrient-chip"><b>F</b> ${fmtNutrient(nutrients.fat_g, 'g')}</span>
        <span class="nutrient-chip"><b>C</b> ${fmtNutrient(nutrients.carbs_g, 'g')}</span>
        <span class="nutrient-chip nutrient-fiber">食物繊維 ${fmtNutrient(nutrients.fiber_g, 'g')}</span>
        <span class="nutrient-chip nutrient-sugar">糖質 ${fmtNutrient(nutrients.sugar_g, 'g')}</span>
        <span class="nutrient-chip nutrient-sodium">塩分 ${fmtNutrient(nutrients.sodium_mg, 'mg')}</span>
        ${pfcLabel ? `<span class="nutrient-chip nutrient-pfc"><b>PFC</b> ${escapeHtml(pfcLabel)}</span>` : ''}
       </div>`
    : '';
  const items = meals.map((m) => {
    // ISO は UTC なので localtime に変換して HH:MM を表示
    const td = new Date(m.eaten_at || '');
    const t = isNaN(td.getTime())
      ? (m.eaten_at || '').slice(11, 16)
      : `${String(td.getHours()).padStart(2, '0')}:${String(td.getMinutes()).padStart(2, '0')}`;
    const desc = m.description || '(未記入)';
    const cal = (typeof m.total_calories === 'number') ? `${m.total_calories} kcal` : '— kcal';
    const adds = (m.additions || []).map((a) => {
      const ac = typeof a.calories === 'number' ? ` ${a.calories}kcal` : '';
      return `＋${a.name}${ac}`;
    }).join(', ');
    const addsHtml = adds ? `<span class="diary-meal-adds muted"> · ${escapeHtml(adds)}</span>` : '';
    return `<li class="diary-meal-row">
      <a class="diary-meal-thumb" href="#" data-meal-id="${m.id}">
        <img src="/api/meals/${m.id}/photo" loading="lazy" alt="" />
      </a>
      <div class="diary-meal-body">
        <div class="diary-meal-head">
          <span class="diary-meal-time">${escapeHtml(t)}</span>
          <span class="diary-meal-cal">${escapeHtml(cal)}</span>
        </div>
        <div class="diary-meal-desc">${escapeHtml(desc)}${addsHtml}</div>
      </div>
    </li>`;
  }).join('');
  wrap.innerHTML = `${totalLine}${nutLine}<ul class="diary-meals-list">${items}</ul>`;
  // クリック → 食事タブに飛ばす
  wrap.querySelectorAll('.diary-meal-thumb').forEach((a) => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      switchTab('meals');
    });
  });
}

function renderDiaryDigList(items, total) {
  const ul = $('diaryDigs');
  if (!items.length) {
    ul.innerHTML = '<li class="queue-empty">この日のディグはなし</li>';
    return;
  }
  ul.innerHTML = items.map(digLi).join('');
  attachDigClicks(ul);
  if (total > items.length) {
    appendDiaryMoreButton(ul, items.length, total, async (offset) => {
      const date = state.diaryDetailDate;
      const r = await api(`/api/diary/${date}/digs?offset=${offset}&limit=20`);
      return { items: (r.items || []).map(digLi), total: r.total };
    });
  }
}
function digLi(dg) {
  return `<li class="diary-dig" data-id="${dg.id}">
    <div class="diary-dig-head">
      <span class="diary-dig-query">${escapeHtml(dg.query)}</span>
      <span class="diary-dig-meta">${dg.source_count} 件 · ${escapeHtml(dg.status)}</span>
    </div>
    ${dg.summary ? `<div class="diary-dig-summary">${escapeHtml(dg.summary)}</div>` : ''}
  </li>`;
}
function attachDigClicks(scope) {
  scope.querySelectorAll('.diary-dig').forEach(li => {
    if (li.dataset.bound === '1') return;
    li.dataset.bound = '1';
    li.addEventListener('click', () => {
      const id = Number(li.dataset.id);
      switchTab('dig');
      loadDigSession(id);
    });
  });
}

// Inserts a "more ▽" button at the end of the list. Each click fetches the
// next page and appends it; when the list is exhausted the button removes
// itself. `fetchPage(offset) → { items: htmlString[], total }`.
function appendDiaryMoreButton(ul, currentLen, total, fetchPage) {
  const li = document.createElement('li');
  li.className = 'diary-more';
  let offset = currentLen;
  const remaining = () => Math.max(0, total - offset);
  function syncLabel(loading) {
    li.innerHTML = loading
      ? '読込中…'
      : `more ▽ <span class="diary-more-count">残り ${remaining()} 件</span>`;
  }
  syncLabel(false);
  li.addEventListener('click', async () => {
    if (li.dataset.busy === '1') return;
    li.dataset.busy = '1';
    syncLabel(true);
    try {
      const { items, total: newTotal } = await fetchPage(offset);
      const frag = document.createElement('div');
      frag.innerHTML = items.join('');
      while (frag.firstChild) ul.insertBefore(frag.firstChild, li);
      attachBookmarkClicks(ul);
      attachDigClicks(ul);
      offset += items.length;
      if (typeof newTotal === 'number') total = newTotal;
      if (offset >= total) li.remove();
      else { syncLabel(false); li.dataset.busy = ''; }
    } catch (e) {
      li.innerHTML = `<span class="error">取得失敗: ${escapeHtml(e.message)}</span>`;
      li.dataset.busy = '';
    }
  });
  ul.appendChild(li);
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
    const [cats, diff, timeline, domains, visitDomains, workHours, keywords, github, gps] = await Promise.all([
      api(`/api/trends/categories?days=${encodeURIComponent(days)}`),
      api(`/api/trends/category-diff?days=7`),
      api(`/api/trends/timeline?days=${encodeURIComponent(days)}`),
      api(`/api/trends/domains?days=${encodeURIComponent(days)}`),
      api(`/api/trends/visit-domains?days=${encodeURIComponent(days)}`),
      api(`/api/trends/work-hours?days=${encodeURIComponent(days)}`),
      api(`/api/trends/keywords?days=${encodeURIComponent(days)}`),
      api(`/api/trends/github?days=${encodeURIComponent(days)}`).catch(() => ({ enabled: false })),
      api(`/api/trends/gps-walking?days=${encodeURIComponent(days)}`).catch(() => ({ items: [] })),
    ]);
    renderTrendCategories(cats.items);
    renderTrendDiff(diff.items);
    renderTrendTimeline(timeline.items);
    renderTrendDomains(domains.items);
    renderTrendVisitDomains(visitDomains.items);
    renderTrendWorkHours(workHours.items);
    renderTrendKeywords(keywords.items);
    renderTrendGithub(github);
    renderTrendGpsWalking(gps.items);
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
  // items: [{date: 'YYYY-MM-DD', minutes: number|null}]
  // null = no diary generated for that day → drop from the line, don't draw 0.
  const present = (items || []).filter(d => Number.isFinite(d.minutes));
  if (!present.length) {
    el.innerHTML = '<div class="queue-empty">作業時間が記録された日記がまだありません</div>';
    return;
  }
  const data = present.map(d => ({ date: d.date, value: d.minutes / 60, raw: d.minutes }));
  el.innerHTML = renderLineChartSvg(data, {
    yLabel: (v) => `${v.toFixed(1)}h`,
    pointLabel: (d) => `${d.date} : ${(d.value).toFixed(1)} 時間 (${d.raw} 分)`,
  });
  attachLineChartTooltip(el);
}

function renderTrendGpsWalking(items) {
  // items: [{date, distance_km, walking_minutes, travel_minutes}]
  const distEl = $('trendWalkDistance');
  const minsEl = $('trendWalkMinutes');
  if (!distEl && !minsEl) return;

  const list = items || [];
  const hasAny = list.some(d => d.distance_km > 0 || d.walking_minutes > 0);
  if (!hasAny) {
    if (distEl) distEl.innerHTML = '<div class="queue-empty">GPS 軌跡が記録されていません</div>';
    if (minsEl) minsEl.innerHTML = '<div class="queue-empty">GPS 軌跡が記録されていません</div>';
    return;
  }
  if (distEl) {
    const data = list.map(d => ({ date: d.date, value: d.distance_km, raw: d }));
    distEl.innerHTML = renderLineChartSvg(data, {
      yLabel: (v) => `${v.toFixed(1)}km`,
      pointLabel: (d) => `${d.date} : ${d.value.toFixed(2)} km (歩行 ${d.raw.walking_minutes} 分 / 移動 ${d.raw.travel_minutes} 分)`,
    });
    attachLineChartTooltip(distEl);
  }
  if (minsEl) {
    const data = list.map(d => ({ date: d.date, value: d.walking_minutes, raw: d }));
    minsEl.innerHTML = renderLineChartSvg(data, {
      yLabel: (v) => `${Math.round(v)}分`,
      pointLabel: (d) => `${d.date} : 歩行 ${d.value} 分 (距離 ${d.raw.distance_km.toFixed(2)} km / 移動 ${d.raw.travel_minutes} 分)`,
    });
    attachLineChartTooltip(minsEl);
  }
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

document.querySelectorAll('.tabs-scroll .tab[data-tab]').forEach(t => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});
{
  const moreBtn = $('tabMoreBtn');
  const moreMenu = $('tabMoreMenu');
  if (moreBtn) {
    moreBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (moreMenu && moreMenu.hidden === false) {
        closeTabMoreMenu();
      } else {
        openTabMoreMenu();
      }
    });
  }
  document.addEventListener('click', (e) => {
    if (!moreMenu || moreMenu.hidden) return;
    if (e.target === moreBtn || moreBtn?.contains(e.target)) return;
    if (moreMenu.contains(e.target)) return;
    closeTabMoreMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTabMoreMenu();
  });
  window.addEventListener('resize', () => {
    reflowTabsForViewport();
    positionTabMoreMenu();
  });
  reflowTabsForViewport();
}
setupCategoriesDrawer();
setupExtensionBadge();
setupHowToBookmark();

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
$('digRunNewTheme')?.addEventListener('click', () => startDig({ forceNewTheme: true }));
$('digPickClear')?.addEventListener('click', () => clearDigPick());
// textarea で Cmd/Ctrl+Enter は ディグる、 通常 Enter は改行のままにする
// (5 行 textarea で複数行クエリを書けるようにするため)。
$('digQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    startDig();
  }
});
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
    // ユーザプロファイル (適正カロリー計算用)
    if (cfg.user_profile) {
      const up = cfg.user_profile;
      if ($('userAge')) $('userAge').value = up.age != null ? String(up.age) : '';
      if ($('userSex')) $('userSex').value = up.sex || '';
      if ($('userWeightKg')) $('userWeightKg').value = up.weight_kg != null ? String(up.weight_kg) : '';
      if ($('userHeightCm')) $('userHeightCm').value = up.height_cm != null ? String(up.height_cm) : '';
      if ($('userActivityLevel')) $('userActivityLevel').value = up.activity_level || 'moderate';
    }
    if (r.runtime) {
      const rt = r.runtime;
      $('aiRuntimeInfo').innerHTML = `
        <div><b>port</b>: ${escapeHtml(String(rt.port))}</div>
        <div><b>data_dir</b>: <code>${escapeHtml(rt.data_dir)}</code></div>
        <div><b>platform</b>: ${escapeHtml(rt.platform)}</div>
      `;
    }
    // Electron 配下のときだけ「デスクトップアプリ」セクションを出す。
    // window.memoria は preload.ts (contextBridge) が expose する。
    const desktop = (typeof window !== 'undefined' && window.memoria) || null;
    if (desktop && $('aiDesktopHead') && $('aiDesktopSection') && $('aiAutoLaunch')) {
      $('aiDesktopHead').hidden = false;
      $('aiDesktopSection').hidden = false;
      try {
        const enabled = await desktop.getAutoLaunch();
        $('aiAutoLaunch').checked = !!enabled;
      } catch (e) { console.warn('getAutoLaunch failed:', e); }
      $('aiAutoLaunch').onchange = async (ev) => {
        try { await desktop.setAutoLaunch(ev.target.checked); }
        catch (e) { alert(`自動起動の設定に失敗: ${e.message}`); }
      };
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
    user_profile: {
      age: parseFloat($('userAge')?.value),
      sex: $('userSex')?.value || '',
      weight_kg: parseFloat($('userWeightKg')?.value),
      height_cm: parseFloat($('userHeightCm')?.value),
      activity_level: $('userActivityLevel')?.value || 'moderate',
    },
  };
  // NaN/empty を null に正規化
  for (const k of ['age', 'weight_kg', 'height_cm']) {
    if (!isFinite(body.user_profile[k])) body.user_profile[k] = null;
  }
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
document.getElementById('pushSubscribeBtn')?.addEventListener('click', () => pushSubscribeFlow().catch(e => setPushStatus(e.message, true)));
document.getElementById('pushTestBtn')?.addEventListener('click', () => pushTestSend().catch(e => setPushStatus(e.message, true)));
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

// ── Tracks (GPS overlay on Google Maps) ───────────────────────────────────
//
// 当日 (or 任意日) の OwnTracks 由来の GPS 軌跡を Google Maps 上に
// Polyline で重ねる。 Google Maps API key は /api/maps/config で取得 →
// script を遅延 inject。 key 未設定なら案内メッセージのみ。

const tracksState = {
  loaded: false,         // google.maps script を読み終えたか
  map: null,
  polyline: null,
  dotMarkers: [],
  apiKey: '',
};

function todayLocalIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function loadTracks() {
  const dateInput = $('tracksDate');
  if (dateInput && !dateInput.value) dateInput.value = todayLocalIso();

  // bind controls (one-time)
  if (!tracksState._bound) {
    tracksState._bound = true;
    dateInput?.addEventListener('change', renderTracksForCurrentDate);
    $('tracksRefresh')?.addEventListener('click', renderTracksForCurrentDate);
    $('tracksKeyToggle')?.addEventListener('click', () => {
      $('tracksKeyPanel').classList.toggle('hidden');
      refreshTracksKeyPanel();
    });
    $('tracksKeyGenerate')?.addEventListener('click', regenerateTracksKey);
    $('tracksKeyClear')?.addEventListener('click', clearTracksKey);
    $('tracksKeyCopy')?.addEventListener('click', () => {
      const v = $('tracksKeyRevealValue')?.textContent ?? '';
      if (v) navigator.clipboard?.writeText(v).catch(() => {});
    });
    document.addEventListener('visibilitychange', () => {
      // タブに戻ってきたら最新の状態に再同期 + WS 再接続
      if (document.visibilityState === 'visible' && state.tab === 'tracks') {
        renderTracksForCurrentDate();
        ensureLiveSocket();
      }
    });
  }

  try {
    const [{ apiKey, hasKey }, { days }] = await Promise.all([
      api('/api/maps/config'),
      api('/api/locations/days?limit=180'),
    ]);
    tracksState.apiKey = apiKey;
    $('tracksMissingKey').classList.toggle('hidden', !!hasKey);
    renderTracksDaysList(days);
    if (hasKey) {
      await ensureGoogleMapsLoaded(apiKey);
      ensureMapInstance();
      renderTracksForCurrentDate();
    }
    refreshTracksKeyPanel();
    ensureLiveSocket();
  } catch (e) {
    console.error('[tracks] load failed', e);
  }
}

// ── ingest key 管理 (HTTP モード用) ──────────────────────────────────────

async function refreshTracksKeyPanel() {
  try {
    const r = await api('/api/locations/settings');
    $('tracksKeyPreview').textContent = r.has_key ? r.key_preview : '未設定';
    $('tracksKeySource').textContent = r.has_key
      ? (r.source === 'env' ? '(env から)' : '(設定済)')
      : '(匿名 ingest 許可中)';
    if (!r.has_key) $('tracksKeyReveal').classList.add('hidden');
  } catch (e) { console.error(e); }
}

async function regenerateTracksKey() {
  if (!confirm('新しい ingest key を生成しますか？\n既存の key は無効になり、 OwnTracks 側の Password を更新する必要があります。')) return;
  try {
    const r = await fetch('/api/locations/settings/regenerate', { method: 'POST' }).then(x => x.json());
    if (!r.key) throw new Error('no key in response');
    $('tracksKeyRevealValue').textContent = r.key;
    $('tracksKeyReveal').classList.remove('hidden');
    refreshTracksKeyPanel();
  } catch (e) {
    alert('key 生成失敗: ' + (e?.message ?? e));
  }
}

async function clearTracksKey() {
  if (!confirm('ingest key をクリアしますか？\nWAN 公開している場合は誰でも /api/locations/ingest に POST できる状態になります。')) return;
  try {
    await fetch('/api/locations/settings/key', { method: 'DELETE' });
    $('tracksKeyReveal').classList.add('hidden');
    refreshTracksKeyPanel();
  } catch (e) { console.error(e); }
}

// ── WebSocket ライブ更新 ─────────────────────────────────────────────────

function ensureLiveSocket() {
  if (tracksState.ws && tracksState.ws.readyState === WebSocket.OPEN) return;
  if (tracksState.ws && tracksState.ws.readyState === WebSocket.CONNECTING) return;

  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://')
    + location.host + '/ws/locations';
  setLiveStatus('connecting');
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    setLiveStatus('error');
    return;
  }
  tracksState.ws = ws;
  ws.addEventListener('open',    () => setLiveStatus('open'));
  ws.addEventListener('close',   () => { setLiveStatus('closed'); scheduleLiveReconnect(); });
  ws.addEventListener('error',   () => setLiveStatus('error'));
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'location' && msg.point) handleLivePoint(msg.point);
  });
}

function scheduleLiveReconnect() {
  if (tracksState.wsReconnectTimer) return;
  if (document.visibilityState !== 'visible') return;
  tracksState.wsReconnectTimer = setTimeout(() => {
    tracksState.wsReconnectTimer = null;
    if (state.tab === 'tracks') ensureLiveSocket();
  }, 3000);
}

function setLiveStatus(s) {
  const el = $('tracksLive');
  if (!el) return;
  el.dataset.live = s;
  el.title = `WS: ${s}`;
}

function handleLivePoint(point) {
  const dateStr = $('tracksDate')?.value;
  if (!dateStr) return;
  const localDay = isoToLocalYmd(point.recorded_at);
  if (localDay !== dateStr) {
    api('/api/locations/days?limit=180').then(({ days }) => renderTracksDaysList(days)).catch(() => {});
    return;
  }
  if (!tracksState.map) return;
  tracksState.todayPoints.push(point);
  appendLivePointToPolyline(point);
  const km = computeDistanceMeters(tracksState.todayPoints) / 1000;
  $('tracksStats').textContent = `${tracksState.todayPoints.length} 点 / 概算 ${km.toFixed(2)} km (live)`;
}

function isoToLocalYmd(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function appendLivePointToPolyline(point) {
  if (!tracksState.polyline) {
    drawTracks([point]);
    return;
  }
  const path = tracksState.polyline.getPath();
  path.push(new google.maps.LatLng(point.lat, point.lon));
  if (tracksState.dotMarkers[1]) {
    tracksState.dotMarkers[1].setPosition({ lat: point.lat, lng: point.lon });
  }
}

function renderTracksDaysList(days) {
  const ul = $('tracksDays');
  if (!ul) return;
  if (!days || days.length === 0) {
    ul.innerHTML = '<li class="muted">記録なし</li>';
    return;
  }
  ul.innerHTML = days.map(d =>
    `<li><button class="link" data-tracks-day="${escapeHtml(d.day)}">${escapeHtml(d.day)}</button>
       <span class="muted">${d.points} 点</span></li>`
  ).join('');
  ul.querySelectorAll('button[data-tracks-day]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dateInput = $('tracksDate');
      if (dateInput) {
        dateInput.value = btn.dataset.tracksDay;
        renderTracksForCurrentDate();
      }
    });
  });
}

function ensureGoogleMapsLoaded(apiKey) {
  if (tracksState.loaded || (window.google && window.google.maps)) {
    tracksState.loaded = true;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cb = `__memoriaMapsCb_${Date.now()}`;
    window[cb] = () => {
      tracksState.loaded = true;
      delete window[cb];
      resolve();
    };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&callback=${cb}&v=weekly`;
    s.async = true;
    s.defer = true;
    s.onerror = () => reject(new Error('Google Maps script failed to load'));
    document.head.appendChild(s);
  });
}

function ensureMapInstance() {
  if (tracksState.map || !window.google?.maps) return;
  const el = $('tracksMap');
  if (!el) return;
  // 起動時の暫定中心 (東京駅)。最初のロード後に bbox に fit する。
  tracksState.map = new google.maps.Map(el, {
    center: { lat: 35.681, lng: 139.767 },
    zoom: 12,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: true,
  });
}

async function renderTracksForCurrentDate() {
  if (!tracksState.map) return;
  const date = $('tracksDate')?.value;
  if (!date) return;
  try {
    const { points } = await api(`/api/locations?date=${encodeURIComponent(date)}`);
    const pts = points || [];
    drawTracks(pts);
    // live append のキャッシュ。 表示中の日付が「今日 (local)」なら使われる。
    tracksState.todayPoints = (date === todayLocalIso()) ? pts.slice() : [];
    const km = computeDistanceMeters(pts) / 1000;
    $('tracksStats').textContent = pts.length
      ? `${pts.length} 点 / 概算 ${km.toFixed(2)} km`
      : '点なし';
  } catch (e) {
    console.error('[tracks] render failed', e);
    $('tracksStats').textContent = '取得失敗';
  }
}

function drawTracks(points) {
  // 既存 overlay をクリア
  if (tracksState.polyline) {
    tracksState.polyline.setMap(null);
    tracksState.polyline = null;
  }
  for (const m of tracksState.dotMarkers) m.setMap(null);
  tracksState.dotMarkers = [];
  if (!points.length) return;

  const path = points.map(p => ({ lat: p.lat, lng: p.lon }));
  tracksState.polyline = new google.maps.Polyline({
    path,
    geodesic: true,
    strokeColor: '#3b82f6',
    strokeOpacity: 0.85,
    strokeWeight: 4,
    map: tracksState.map,
  });

  // 始点 / 終点に小さなマーカーを置く (path が長くてもマーカーは 2 個だけ)
  const start = path[0];
  const end = path[path.length - 1];
  tracksState.dotMarkers.push(new google.maps.Marker({
    position: start, map: tracksState.map, title: '開始',
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: '#10b981', fillOpacity: 1, strokeColor: '#065f46', strokeWeight: 1 },
  }));
  tracksState.dotMarkers.push(new google.maps.Marker({
    position: end, map: tracksState.map, title: '終端',
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: '#ef4444', fillOpacity: 1, strokeColor: '#7f1d1d', strokeWeight: 1 },
  }));

  // bbox に fit
  const b = new google.maps.LatLngBounds();
  for (const p of path) b.extend(p);
  tracksState.map.fitBounds(b, 60);
}

function computeDistanceMeters(points) {
  if (!points || points.length < 2) return 0;
  const R = 6_371_008;
  const toRad = d => (d * Math.PI) / 180;
  let dist = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (b.accuracy_m && b.accuracy_m > 200) continue;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const sa = Math.sin(dLat / 2);
    const so = Math.sin(dLon / 2);
    const h = sa * sa + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * so * so;
    dist += 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  return dist;
}

// ── WebPush (PWA notifications) ────────────────────────────────────────────
//
// iOS Safari は homescreen 追加した PWA でないと PushManager.subscribe を許可
// しない (16.4+)。 設定画面の「通知を有効化」 ボタンから flow を開始する。

function setPushStatus(msg, isError = false) {
  const el = document.getElementById('pushStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#b00' : '';
}

function urlBase64ToUint8Array(base64String) {
  // VAPID public key (base64url) を Uint8Array に変換 — PushManager.subscribe
  // は applicationServerKey に Uint8Array か ArrayBuffer を要求する
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function ensureServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('この端末は Service Worker 非対応です');
  }
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

async function pushSubscribeFlow() {
  if (!('Notification' in window) || !('PushManager' in window)) {
    throw new Error('この端末は WebPush 非対応です (iOS なら 16.4+ + ホーム画面追加)');
  }
  setPushStatus('Service Worker を登録中…');
  const reg = await ensureServiceWorker();

  setPushStatus('通知許可をリクエスト中…');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new Error(`通知許可が拒否されました (${perm})`);
  }

  setPushStatus('VAPID 鍵を取得中…');
  const { publicKey } = await api('/api/push/vapid-public-key');
  if (!publicKey) throw new Error('サーバ側 VAPID が未構成です');

  setPushStatus('PushManager.subscribe 中…');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const json = sub.toJSON();
  setPushStatus('サーバに登録中…');
  await api('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: json.keys,
      userAgent: navigator.userAgent,
    }),
  });

  setPushStatus('✅ 通知有効化完了');
  await refreshPushDevices();
}

async function pushTestSend() {
  setPushStatus('テスト通知を送信中…');
  const r = await api('/api/push/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  setPushStatus(`送信: ${r.sent} / 失効: ${r.revoked} / エラー: ${r.errors?.length || 0}`);
}

async function refreshPushDevices() {
  const ul = document.getElementById('pushDevicesList');
  if (!ul) return;
  try {
    const r = await api('/api/push/subscriptions');
    const items = r.items || [];
    ul.innerHTML = '';
    if (items.length === 0) {
      ul.innerHTML = '<li class="hint">登録された端末はまだありません</li>';
      return;
    }
    for (const it of items) {
      const li = document.createElement('li');
      const status = it.revoked_at ? '🚫 失効' : '🟢 有効';
      const ua = it.user_agent ? it.user_agent.slice(0, 60) : '(unknown)';
      li.innerHTML = `<span>${status} #${it.id} <small>${ua}</small></span>`;
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = '解除';
      btn.addEventListener('click', async () => {
        await api(`/api/push/subscriptions/${it.id}`, { method: 'DELETE' });
        await refreshPushDevices();
      });
      li.appendChild(btn);
      ul.appendChild(li);
    }
  } catch (e) {
    ul.innerHTML = `<li class="hint">読み込み失敗: ${e.message}</li>`;
  }
}

// 初期 SW register (subscribe ボタンを押す前に load しておくと、 push event
// を受け取れる状態になる)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
    console.warn('[sw] register failed:', err);
  });
}
// 設定画面が開いた時に端末リストを更新する hook (openAiSettings 内に
// 食い込むより、 メニュー click 経路に被せる)
document.getElementById('aiSettingsBtn')?.addEventListener('click', () => {
  refreshPushDevices().catch(() => {});
});

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


// ── Meals (食事記録) ─────────────────────────────────────────────────────
//
// /api/meals (multipart) で写真投稿 → サーバが EXIF / GPS / Vision で
// 補完 → 一覧 + 編集。 OPENAI_API_KEY が無いと内容 / カロリーは pending のまま、
// 手動入力で運用可能。

const mealsState = {
  items: [],
  pollTimer: null,
};

// ── 外部情報設定 (Legatus DNS/SNI tap) ────────────────────────────
async function loadExternalConfig() {
  try {
    const r = await api('/api/visits/external/stats');
    const $set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    $set('extCfgCount24h', String(r.count_24h ?? 0));
    $set('extCfgCount7d', String(r.count_7d ?? 0));
    $set('extCfgDeviceCount', String(r.device_count ?? 0));
    $set('extCfgLatest', r.latest ? new Date(r.latest.replace(' ', 'T') + 'Z').toLocaleString() : '—');

    const recent = document.getElementById('extCfgRecent');
    if (recent) {
      const items = Array.isArray(r.recent) ? r.recent : [];
      if (items.length === 0) {
        recent.innerHTML = '<div class="hint">まだ取り込みがありません。 下のセットアップ手順を実施してください。</div>';
      } else {
        recent.innerHTML = `
          <h4>直近 20 件</h4>
          <table class="ext-cfg-recent-tbl">
            <thead><tr><th>時刻</th><th>device</th><th>OS</th><th>source</th><th>domain</th></tr></thead>
            <tbody>
              ${items.map((e) => `
                <tr>
                  <td>${escapeHtml(new Date((e.visited_at || '').replace(' ', 'T') + 'Z').toLocaleString())}</td>
                  <td>${escapeHtml(e.device_label || '—')}</td>
                  <td>${escapeHtml(e.device_os || '—')}</td>
                  <td><span class="ext-cfg-src ext-cfg-src-${escapeHtml(e.source || 'unknown')}">${escapeHtml(e.source || '—')}</span></td>
                  <td>${escapeHtml(e.domain || '—')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        `;
      }
    }
  } catch (e) {
    const recent = document.getElementById('extCfgRecent');
    if (recent) recent.innerHTML = `<div class="hint">取得エラー: ${escapeHtml(e.message)}</div>`;
  }
}

// コピーボタン (data-copy-env="legatus" / "dnsmasq")
document.addEventListener('click', (ev) => {
  const btn = ev.target?.closest?.('[data-copy-env]');
  if (!btn) return;
  const block = btn.previousElementSibling?.querySelector('code');
  if (!block) return;
  navigator.clipboard?.writeText(block.textContent || '').then(() => {
    const orig = btn.textContent;
    btn.textContent = '✓ コピー済';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  }).catch(() => {});
});

async function loadMeals() {
  const list = document.getElementById('mealsList');
  if (!list) return;
  // 単一日付フィルタ — 値があれば「その日 0:00 〜 23:59」 で絞り込み
  const dateEl = document.getElementById('mealsFilterDate');
  const params = new URLSearchParams();
  const v = dateEl?.value;
  if (v) {
    params.set('from', v + 'T00:00:00');
    params.set('to', v + 'T23:59:59');
  }
  try {
    const r = await api(`/api/meals?${params.toString()}`);
    mealsState.items = r.meals || [];
    renderMeals();
    schedulePendingPoll();
  } catch (e) {
    list.innerHTML = `<div class="hint">読み込みエラー: ${escapeHtml(e.message)}</div>`;
  }
}

function renderMeals() {
  const list = document.getElementById('mealsList');
  if (!list) return;
  if (mealsState.items.length === 0) {
    list.innerHTML = '<div class="hint">まだ食事の記録はありません。 「📷 写真を追加」 から登録してください。</div>';
    return;
  }
  list.innerHTML = mealsState.items.map((m) => {
    const desc = m.user_corrected_description || m.description || (m.ai_status === 'pending' ? '解析中…' : m.ai_status === 'error' ? '解析失敗' : '(未記入)');
    const baseCal = m.user_corrected_calories ?? m.calories;
    const additions = parseMealAdditions(m.additions_json);
    const addCalSum = additions.reduce((s, a) => s + (typeof a.calories === 'number' ? a.calories : 0), 0);
    const totalCal = (baseCal == null && additions.length === 0) ? null : (baseCal ?? 0) + addCalSum;
    const calStr = totalCal == null ? '— kcal' : `${totalCal} kcal`;
    const eatenAt = formatLocalMealDateTime(m.eaten_at);
    const locStr = m.location_label || (m.lat != null && m.lon != null ? `${m.lat.toFixed(4)}, ${m.lon.toFixed(4)}` : '場所不明');
    const aiBadge = m.ai_status === 'pending'
      ? '<span class="meal-badge meal-badge-pending">解析中</span>'
      : m.ai_status === 'error'
      ? `<span class="meal-badge meal-badge-error" title="${escapeHtml(m.ai_error || '')}">解析失敗</span>`
      : '';
    const additionsHtml = additions.length === 0 ? '' : `
      <ul class="meal-additions">
        ${additions.map((a, i) => {
          const calLabel = typeof a.calories === 'number' ? `${a.calories} kcal` : '— kcal';
          const timeLabel = a.added_at ? formatLocalMealDateTime(a.added_at) : '';
          return `
            <li class="meal-addition" data-meal-id="${m.id}" data-idx="${i}">
              <span class="meal-addition-name">＋ ${escapeHtml(a.name)}</span>
              <span class="meal-addition-cal">${escapeHtml(calLabel)}</span>
              ${timeLabel ? `<span class="meal-addition-time">${escapeHtml(timeLabel)}</span>` : ''}
              <button class="ghost meal-addition-edit" data-id="${m.id}" data-idx="${i}" title="編集">✏️</button>
              <button class="ghost meal-addition-delete" data-id="${m.id}" data-idx="${i}" title="削除">×</button>
            </li>
          `;
        }).join('')}
      </ul>
    `;
    const photoHtml = m.photo_path
      ? `<img class="meal-photo" src="/api/meals/${m.id}/photo" loading="lazy" alt="食事写真" />`
      : `<div class="meal-photo meal-photo-empty" aria-label="写真なし"><span class="meal-photo-empty-icon">📝</span><span class="meal-photo-empty-label">写真なし</span></div>`;
    return `
      <div class="meal-card" data-meal-id="${m.id}">
        ${photoHtml}
        <div class="meal-body">
          <div class="meal-head">
            <button class="meal-time-edit" data-id="${m.id}" data-current="${escapeHtml(toDatetimeLocalValue(m.eaten_at))}" title="クリックで時刻を編集">
              <span class="meal-time">${escapeHtml(eatenAt)}</span>
              <span class="meal-time-pencil">✏️</span>
            </button>
            ${aiBadge}
          </div>
          <button class="meal-desc meal-inline-editable" data-id="${m.id}" data-field="description" data-current="${escapeHtml(m.user_corrected_description || m.description || '')}" title="クリックで内容を編集">
            ${escapeHtml(desc)}
            <span class="meal-inline-pencil">✏️</span>
          </button>
          <div class="meal-meta">
            <span class="meal-cal">${escapeHtml(calStr)}</span>
            <button class="meal-loc meal-inline-editable" data-id="${m.id}" data-field="location" data-lat="${m.lat ?? ''}" data-lon="${m.lon ?? ''}" title="クリックで場所を編集">
              ${escapeHtml(locStr)}
              <span class="meal-inline-pencil">✏️</span>
            </button>
            ${(m.lat != null && m.lon != null) ? `<a class="meal-loc-map-link" href="https://www.google.com/maps?q=${encodeURIComponent(m.lat)},${encodeURIComponent(m.lon)}" target="_blank" rel="noopener" title="Google Maps で開く" onclick="event.stopPropagation()">↗ Maps</a>` : ''}
          </div>
          ${m.user_note ? `<div class="meal-note">📝 ${escapeHtml(m.user_note)}</div>` : ''}
          ${additionsHtml}
          <div class="meal-actions">
            <button class="ghost meal-edit-full-btn" data-id="${m.id}" title="ダイアログで全項目を編集">✏️ 編集</button>
            <button class="ghost meal-add-btn" data-id="${m.id}">➕ 追加で食べた</button>
            <button class="ghost meal-reanalyze-btn" data-id="${m.id}" ${m.photo_path ? '' : 'hidden'}>🔄 再解析</button>
            <button class="ghost meal-delete-btn" data-id="${m.id}">🗑️ 削除</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
  // 直近の写真で解析エラーが続いたら設定確認の hint を表示
  const hint = document.getElementById('mealsHint');
  if (hint) {
    const recentErrors = mealsState.items.slice(0, 5).filter((m) => m.ai_status === 'error').length;
    hint.classList.toggle('hidden', recentErrors < 2);
  }
  list.querySelectorAll('.meal-edit-full-btn').forEach((b) => {
    b.addEventListener('click', () => openMealEditModal(Number(b.dataset.id)));
  });
  list.querySelectorAll('.meal-reanalyze-btn').forEach((b) => {
    b.addEventListener('click', () => reanalyzeMeal(Number(b.dataset.id)));
  });
  list.querySelectorAll('.meal-delete-btn').forEach((b) => {
    b.addEventListener('click', () => deleteMealRow(Number(b.dataset.id)));
  });
  list.querySelectorAll('.meal-add-btn').forEach((b) => {
    b.addEventListener('click', () => addMealAddition(Number(b.dataset.id)));
  });
  list.querySelectorAll('.meal-time-edit').forEach((b) => {
    b.addEventListener('click', (ev) => {
      // editing 状態の中の input/button が再帰しないように
      if (ev.target.closest('.meal-time-actions') || ev.target.tagName === 'INPUT') return;
      startMealTimeEdit(b);
    });
  });
  list.querySelectorAll('.meal-inline-editable[data-field="description"]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.meal-inline-actions') || ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
      startMealDescriptionEdit(el);
    });
  });
  list.querySelectorAll('.meal-inline-editable[data-field="location"]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.meal-inline-actions') || ev.target.tagName === 'INPUT' || ev.target.tagName === 'BUTTON') return;
      startMealLocationEdit(el);
    });
  });
  list.querySelectorAll('.meal-addition-edit').forEach((b) => {
    b.addEventListener('click', () => editMealAddition(Number(b.dataset.id), Number(b.dataset.idx)));
  });
  list.querySelectorAll('.meal-addition-delete').forEach((b) => {
    b.addEventListener('click', () => deleteMealAddition(Number(b.dataset.id), Number(b.dataset.idx)));
  });
}

function parseMealAdditions(json) {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** ISO8601 → `YYYY-MM-DDTHH:MM` (datetime-local 用 / ローカル時刻基準)。 */
function toDatetimeLocalValue(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

/** 時刻表示の隣の ✏️ をクリックしたら inline picker に切り替えて即時 PATCH。 */
function startMealTimeEdit(btn) {
  const mealId = Number(btn.dataset.id);
  const current = btn.dataset.current || '';
  if (btn.classList.contains('editing')) return;
  btn.classList.add('editing');

  // 元の中身 (span 2 つ) を退避してから input に置き換える
  const original = btn.innerHTML;
  btn.innerHTML = `
    <input type="datetime-local" class="meal-time-input" value="${current}" />
    <span class="meal-time-actions">
      <button class="meal-time-save" type="button" title="保存">✓</button>
      <button class="meal-time-cancel" type="button" title="キャンセル">×</button>
    </span>
  `;
  const input = btn.querySelector('input');
  const saveBtn = btn.querySelector('.meal-time-save');
  const cancelBtn = btn.querySelector('.meal-time-cancel');
  input?.focus();

  function restore() {
    btn.innerHTML = original;
    btn.classList.remove('editing');
  }

  async function save() {
    const v = input?.value || '';
    if (!v) { restore(); return; }
    try {
      // datetime-local の文字列をそのまま PATCH に渡す (サーバ側で new Date() → ISO8601)
      await api(`/api/meals/${mealId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eaten_at: v }),
      });
      await loadMeals();
    } catch (e) {
      alert(`時刻修正エラー: ${e.message}`);
      restore();
    }
  }

  saveBtn?.addEventListener('click', (ev) => { ev.stopPropagation(); save(); });
  cancelBtn?.addEventListener('click', (ev) => { ev.stopPropagation(); restore(); });
  input?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); save(); }
    if (ev.key === 'Escape') { ev.preventDefault(); restore(); }
  });
  input?.addEventListener('click', (ev) => ev.stopPropagation());
}

function formatLocalMealDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso || '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function schedulePendingPoll() {
  if (mealsState.pollTimer) clearTimeout(mealsState.pollTimer);
  // 解析中 (ai_status=pending) または addition の calories 未確定なら polling
  const hasPending = mealsState.items.some((m) => {
    if (m.ai_status === 'pending') return true;
    const adds = parseMealAdditions(m.additions_json);
    return adds.some((a) => a.calories == null);
  });
  if (!hasPending) return;
  mealsState.pollTimer = setTimeout(() => {
    if (state.tab !== 'meals') return;
    loadMeals();
  }, 4000);
}

// ── 食事登録モーダル — 写真 / 写真なし いずれも 1 件ずつ確認画面を出す ──
//
// queue にためて 1 件ずつ open / submit / next。 キャンセルで queue 全破棄。

const mealModalState = {
  queue: [],
  currentIndex: 0,
  totalCount: 0,
  current: null,
};

function ensureBlobUrlRevoked(item) {
  if (item?.blobUrl) {
    URL.revokeObjectURL(item.blobUrl);
    item.blobUrl = '';
  }
}

function clearMealQueue() {
  for (const it of mealModalState.queue) ensureBlobUrlRevoked(it);
  if (mealModalState.current) ensureBlobUrlRevoked(mealModalState.current);
  mealModalState.queue = [];
  mealModalState.currentIndex = 0;
  mealModalState.totalCount = 0;
  mealModalState.current = null;
}

function enqueueMealModal(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  const wasIdle = mealModalState.queue.length === 0 && !mealModalState.current;
  for (const it of items) {
    if (it.kind === 'photo' && it.file) {
      it.blobUrl = URL.createObjectURL(it.file);
    }
    mealModalState.queue.push(it);
  }
  // 進捗総数 = 現在処理中分 + 残りキュー
  mealModalState.totalCount = mealModalState.currentIndex + (mealModalState.current ? 0 : 0) + mealModalState.queue.length + (mealModalState.current ? 1 : 0);
  if (wasIdle) advanceMealQueue();
}

function advanceMealQueue() {
  if (mealModalState.current) ensureBlobUrlRevoked(mealModalState.current);
  const next = mealModalState.queue.shift();
  if (!next) {
    closeMealModal();
    return;
  }
  mealModalState.current = next;
  mealModalState.currentIndex += 1;
  openMealModal(next);
}

function openMealModal(item) {
  const modal = document.getElementById('mealModal');
  if (!modal) return;
  // グローバル `.hidden { display: none !important }` が残っていると
  // showModal で [open] が付いても表示されないので、 念のため毎回 remove。
  modal.classList.remove('hidden');
  // <dialog>.showModal() でネイティブ popup として開く (focus trap / Esc 自動)。
  // 古い iOS Safari (< 15.4) や一部の WebView では showModal が未実装。
  // どんな環境でも確実に開けるよう、 stub 失敗時は手動で open 属性 + flex を強制。
  let openedNatively = false;
  if (typeof modal.showModal === 'function' && !modal.open) {
    try {
      modal.showModal();
      openedNatively = true;
    } catch (e) {
      console.warn('[meal-modal] showModal failed, falling back:', e);
    }
  }
  if (!openedNatively) {
    // dialog 非対応 / showModal 失敗時の fallback — open 属性 + 直接 style 指定
    modal.setAttribute('open', '');
    modal.style.display = 'flex';
    modal.style.position = 'fixed';
    modal.style.inset = '0';
    modal.style.zIndex = '1000';
    // ネイティブ ::backdrop が出ない fallback の場合、 dialog 自体の背景で
    // 半透明黒を塗って他クリックを封じる
    modal.style.background = 'rgba(0, 0, 0, 0.45)';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
  }

  const photoImg = document.getElementById('mealModalPhoto');
  const photoEmpty = document.getElementById('mealModalPhotoEmpty');
  if (item.kind === 'photo' && item.blobUrl) {
    photoImg.src = item.blobUrl;
    photoImg.hidden = false;
    photoEmpty.classList.add('hidden');
  } else if (item.kind === 'edit' && item.meal?.photo_path) {
    // 編集 mode: 既存写真をサーバ URL から表示
    photoImg.src = `/api/meals/${item.meal.id}/photo?t=${Date.now()}`;
    photoImg.hidden = false;
    photoEmpty.classList.add('hidden');
  } else {
    photoImg.hidden = true;
    photoImg.removeAttribute('src');
    photoEmpty.classList.remove('hidden');
  }

  const descEl = document.getElementById('mealModalDesc');
  const eatenEl = document.getElementById('mealModalEatenAt');
  const latEl = document.getElementById('mealModalLat');
  const lonEl = document.getElementById('mealModalLon');
  const calEl = document.getElementById('mealModalCal');
  const noteEl = document.getElementById('mealModalNote');
  const descHint = document.getElementById('mealModalDescHint');
  const titleEl = document.getElementById('mealModalTitle');
  const submitEl = document.getElementById('mealModalSubmit');

  if (item.kind === 'edit' && item.meal) {
    // 既存値を埋める
    const m = item.meal;
    if (descEl) descEl.value = m.user_corrected_description || m.description || '';
    if (eatenEl) eatenEl.value = toDatetimeLocalValue(m.eaten_at);
    if (latEl) latEl.value = m.lat != null ? String(m.lat) : '';
    if (lonEl) lonEl.value = m.lon != null ? String(m.lon) : '';
    const cal = m.user_corrected_calories ?? m.calories;
    if (calEl) calEl.value = cal != null ? String(cal) : '';
    if (noteEl) noteEl.value = m.user_note || '';
    if (titleEl) titleEl.textContent = `食事を編集 #${m.id}`;
    if (submitEl) submitEl.textContent = '保存';
  } else {
    if (descEl) descEl.value = '';
    if (eatenEl) eatenEl.value = toDatetimeLocalValue(new Date().toISOString());
    if (latEl) latEl.value = '';
    if (lonEl) lonEl.value = '';
    if (calEl) calEl.value = '';
    if (noteEl) noteEl.value = '';
    if (titleEl) titleEl.textContent = '食事を登録';
    if (submitEl) submitEl.textContent = '登録';
  }
  updateMealModalMapLink();

  // 写真あり (新規 / 編集) なら description 任意、 写真なし (manual) は必須
  const hasPhoto = item.kind === 'photo' || (item.kind === 'edit' && item.meal?.photo_path);
  if (hasPhoto) {
    descEl?.removeAttribute('required');
    if (descHint) descHint.textContent = item.kind === 'edit'
      ? '空欄なら AI 結果に戻ります'
      : '空欄なら AI が画像から推定 (Claude Vision)';
  } else {
    descEl?.setAttribute('required', 'required');
    if (descHint) descHint.textContent = '写真なしの場合は内容必須。 カロリー空欄なら AI 推定';
  }

  const total = mealModalState.totalCount;
  const idx = mealModalState.currentIndex;
  const prog = document.getElementById('mealModalProgress');
  if (prog) prog.textContent = total > 1 ? `${idx} / ${total}` : '';
  const skipBtn = document.getElementById('mealModalSkip');
  if (skipBtn) skipBtn.hidden = mealModalState.queue.length === 0;

  setTimeout(() => descEl?.focus(), 30);
}

function closeMealModal() {
  const modal = document.getElementById('mealModal');
  if (modal) {
    if (typeof modal.close === 'function' && modal.open) {
      try { modal.close(); }
      catch (e) { console.warn('[meal-modal] close failed:', e); }
    }
    // fallback で付けた open 属性 / inline style をクリア。
    // `.hidden` は付けない — 次回 showModal 時に `display: none !important`
    // が `dialog[open]` を上書きしてしまうため。 dialog は UA 既定で
    // `:not([open])` のとき非表示になる。
    modal.removeAttribute('open');
    modal.style.display = '';
    modal.style.position = '';
    modal.style.inset = '';
    modal.style.zIndex = '';
    modal.style.background = '';
    modal.style.alignItems = '';
    modal.style.justifyContent = '';
  }
  // 地図リソースもクリア
  mealMapState.marker = null;
  mealModalState.current = null;
  mealModalState.currentIndex = 0;
  mealModalState.totalCount = 0;
}

// ── 食事モーダル: Google Map 連携 ───────────────────────────────
//
// 既存の tracksMap で使う API key とローダ (ensureGoogleMapsLoaded) を
// 流用。 モーダル内に小さな地図を埋め込み、 クリック/タップで lat/lon を
// フォームへ反映。 API key 未設定時は外部リンク (Maps で開く) のみ提供。

const mealMapState = {
  apiKey: null,         // null=未取得、 ''=未設定確定、 string=取得済
  fetched: false,
  map: null,            // google.maps.Map インスタンス
  marker: null,
};

async function fetchMapsApiKey() {
  if (mealMapState.fetched) return mealMapState.apiKey;
  try {
    const cfg = await api('/api/maps/config');
    mealMapState.apiKey = cfg.hasKey ? (cfg.apiKey || '') : '';
  } catch {
    mealMapState.apiKey = '';
  }
  mealMapState.fetched = true;
  return mealMapState.apiKey;
}

async function ensureMealModalMap(initialLat, initialLon) {
  const wrap = document.getElementById('mealModalMap');
  if (!wrap) return;
  const apiKey = await fetchMapsApiKey();
  if (!apiKey) {
    wrap.innerHTML = '<div class="hint">Google Maps API key 未設定。 設定 → AI / 連携 で <code>maps.api_key</code> を入れるか、 「↗ Maps で開く」 リンクで外部表示してください。</div>';
    return;
  }
  try {
    await ensureGoogleMapsLoaded(apiKey);
  } catch (e) {
    wrap.innerHTML = `<div class="hint">Google Maps の読み込みに失敗: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!window.google?.maps) return;

  // 中心点: 既存値 → 直近の GPS 軌跡 → 東京駅
  const center = (initialLat != null && initialLon != null)
    ? { lat: Number(initialLat), lng: Number(initialLon) }
    : { lat: 35.681, lng: 139.767 };

  // 既存の Map インスタンスがあれば再利用、 そうでなければ新規作成
  if (!mealMapState.map) {
    mealMapState.map = new google.maps.Map(wrap, {
      center,
      zoom: 15,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
    });
    mealMapState.map.addListener('click', (ev) => {
      const lat = ev.latLng.lat();
      const lon = ev.latLng.lng();
      setMealModalLatLon(lat, lon, /*recenter*/ false);
    });
  } else {
    mealMapState.map.setCenter(center);
    mealMapState.map.setZoom(15);
    google.maps.event.trigger(mealMapState.map, 'resize');
  }
  if (initialLat != null && initialLon != null) {
    placeMealModalMarker(Number(initialLat), Number(initialLon));
  } else if (mealMapState.marker) {
    mealMapState.marker.setMap(null);
    mealMapState.marker = null;
  }
}

function placeMealModalMarker(lat, lon) {
  if (!mealMapState.map) return;
  const pos = new google.maps.LatLng(lat, lon);
  if (!mealMapState.marker) {
    mealMapState.marker = new google.maps.Marker({
      position: pos,
      map: mealMapState.map,
      draggable: true,
    });
    mealMapState.marker.addListener('dragend', (ev) => {
      const dlat = ev.latLng.lat();
      const dlon = ev.latLng.lng();
      setMealModalLatLon(dlat, dlon, /*recenter*/ false);
    });
  } else {
    mealMapState.marker.setPosition(pos);
    mealMapState.marker.setMap(mealMapState.map);
  }
}

function setMealModalLatLon(lat, lon, recenter) {
  const latEl = document.getElementById('mealModalLat');
  const lonEl = document.getElementById('mealModalLon');
  if (latEl) latEl.value = String(lat.toFixed ? lat.toFixed(6) : lat);
  if (lonEl) lonEl.value = String(lon.toFixed ? lon.toFixed(6) : lon);
  placeMealModalMarker(Number(lat), Number(lon));
  if (recenter && mealMapState.map) {
    mealMapState.map.setCenter(new google.maps.LatLng(Number(lat), Number(lon)));
  }
  updateMealModalMapLink();
}

function clearMealModalMarker() {
  if (mealMapState.marker) {
    mealMapState.marker.setMap(null);
    mealMapState.marker = null;
  }
}

function updateMealModalMapLink() {
  const link = document.getElementById('mealModalMapOpen');
  if (!link) return;
  const latEl = document.getElementById('mealModalLat');
  const lonEl = document.getElementById('mealModalLon');
  const lat = latEl?.value?.trim();
  const lon = lonEl?.value?.trim();
  if (lat && lon && isFinite(Number(lat)) && isFinite(Number(lon))) {
    link.href = `https://www.google.com/maps?q=${encodeURIComponent(lat)},${encodeURIComponent(lon)}`;
    link.hidden = false;
  } else {
    link.hidden = true;
    link.removeAttribute('href');
  }
}

function readMealModalForm() {
  const desc = (document.getElementById('mealModalDesc')?.value || '').trim();
  const eatenAt = (document.getElementById('mealModalEatenAt')?.value || '').trim();
  const latRaw = (document.getElementById('mealModalLat')?.value || '').trim();
  const lonRaw = (document.getElementById('mealModalLon')?.value || '').trim();
  const calRaw = (document.getElementById('mealModalCal')?.value || '').trim();
  const note = (document.getElementById('mealModalNote')?.value || '').trim();
  const lat = latRaw === '' ? null : Number(latRaw);
  const lon = lonRaw === '' ? null : Number(lonRaw);
  const calories = calRaw === '' ? null : Number(calRaw);
  return { desc, eatenAt, lat, lon, calories, note };
}

async function submitMealModal() {
  const item = mealModalState.current;
  if (!item) return;
  const { desc, eatenAt, lat, lon, calories, note } = readMealModalForm();
  const status = document.getElementById('mealsUploadStatus');

  if (item.kind === 'manual' && !desc) {
    alert('食事内容を入力してください');
    return;
  }

  if (status) status.textContent = item.kind === 'edit' ? `📝 保存中…` : `📤 登録中…`;

  try {
    if (item.kind === 'edit') {
      // 既存 meal の編集 → PATCH /api/meals/:id
      const m = item.meal;
      const patch = {};
      // description: 空文字なら null (= AI 結果へ戻す) に明示
      const prevDesc = m.user_corrected_description || m.description || '';
      if (desc !== prevDesc) {
        patch.user_corrected_description = desc || null;
        // 内容変更でカロリー再推定をかけたい場合は user_corrected_calories=null
        // (背景再推定が走る)。 ただしユーザが明示的にカロリー入れた場合は保持
      }
      if (eatenAt) patch.eaten_at = eatenAt;
      if (lat != null && lon != null && isFinite(lat) && isFinite(lon)) {
        patch.lat = lat; patch.lon = lon;
      } else if (lat == null && lon == null) {
        patch.lat = null; patch.lon = null;
      }
      // calories: 入力値があればそのまま、 空欄なら null (再推定許可)
      if (calories != null && isFinite(calories)) {
        patch.user_corrected_calories = calories;
      } else {
        patch.user_corrected_calories = null;
      }
      patch.user_note = note || null;
      await api(`/api/meals/${m.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (status) status.textContent = `✅ 保存しました`;
    } else if (item.kind === 'photo') {
      const fd = new FormData();
      fd.append('photo', item.file);
      if (eatenAt) fd.append('eaten_at', eatenAt);
      if (lat != null && lon != null && isFinite(lat) && isFinite(lon)) {
        fd.append('lat', String(lat));
        fd.append('lon', String(lon));
      }
      if (note) fd.append('user_note', note);
      const res = await fetch('/api/meals', { method: 'POST', body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const patch = {};
      if (desc) patch.user_corrected_description = desc;
      if (calories != null && isFinite(calories)) patch.user_corrected_calories = calories;
      if (Object.keys(patch).length > 0 && data.meal?.id) {
        await api(`/api/meals/${data.meal.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
      }
      if (status) status.textContent = `✅ 登録しました`;
    } else {
      const body = { description: desc };
      if (eatenAt) body.eaten_at = eatenAt;
      if (lat != null && lon != null && isFinite(lat) && isFinite(lon)) {
        body.lat = lat; body.lon = lon;
      }
      if (calories != null && isFinite(calories)) body.calories = calories;
      if (note) body.user_note = note;
      await api('/api/meals/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (status) status.textContent = `✅ 登録しました`;
    }
  } catch (e) {
    if (status) status.textContent = item.kind === 'edit'
      ? `⚠ 保存エラー: ${e.message}`
      : `⚠ 登録エラー: ${e.message}`;
    console.warn('[meals] submit error:', e);
  }
  await loadMeals();
  advanceMealQueue();
}

function skipMealModalItem() {
  if (mealModalState.current) ensureBlobUrlRevoked(mealModalState.current);
  mealModalState.current = null;
  advanceMealQueue();
}

function cancelMealModal() {
  clearMealQueue();
  closeMealModal();
}

function startMealModalForFiles(files) {
  const items = Array.from(files || [])
    .filter((f) => f && f.type?.startsWith?.('image/'))
    .map((file) => ({ kind: 'photo', file, blobUrl: '' }));
  if (items.length === 0) return;
  enqueueMealModal(items);
}

function startMealModalForManual() {
  enqueueMealModal([{ kind: 'manual' }]);
}

function openMealEditModal(mealId) {
  const m = mealsState.items.find((x) => x.id === mealId);
  if (!m) return;
  // 編集 mode は 1 件のみ — 既存キューがあれば優先 (連続編集は順次)
  enqueueMealModal([{ kind: 'edit', meal: m }]);
}

async function reanalyzeMeal(id) {
  try {
    await api(`/api/meals/${id}/reanalyze`, { method: 'POST' });
    await loadMeals();
  } catch (e) {
    alert(`再解析エラー: ${e.message}`);
  }
}

async function deleteMealRow(id) {
  if (!confirm('この食事記録を削除しますか?')) return;
  try {
    await api(`/api/meals/${id}`, { method: 'DELETE' });
    await loadMeals();
  } catch (e) {
    alert(`削除エラー: ${e.message}`);
  }
}

// ── 補足メモのみ編集 (旧 editMeal の縮小版) ─────────────────
async function editMealNote(id) {
  const m = mealsState.items.find((x) => x.id === id);
  if (!m) return;
  const note = prompt('補足メモ', m.user_note || '');
  if (note === null) return;
  try {
    await api(`/api/meals/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_note: note }),
    });
    await loadMeals();
  } catch (e) {
    alert(`メモ保存エラー: ${e.message}`);
  }
}

// ── 食事内容 inline 編集 (textarea) ─────────────────────────
function startMealDescriptionEdit(btn) {
  if (btn.classList.contains('editing')) return;
  const mealId = Number(btn.dataset.id);
  const current = btn.dataset.current || '';
  btn.classList.add('editing');
  const original = btn.innerHTML;
  btn.innerHTML = `
    <textarea class="meal-desc-input" rows="2">${escapeHtml(current)}</textarea>
    <span class="meal-inline-actions">
      <button class="meal-inline-save" type="button" title="保存 (カロリー再推定)">✓</button>
      <button class="meal-inline-cancel" type="button" title="キャンセル">×</button>
    </span>
  `;
  const ta = btn.querySelector('textarea');
  ta?.focus();
  ta?.setSelectionRange(ta.value.length, ta.value.length);

  function restore() { btn.innerHTML = original; btn.classList.remove('editing'); }

  async function save() {
    const v = (ta?.value ?? '').trim();
    if (!v) { restore(); return; }
    if (v === current) { restore(); return; }
    try {
      // PATCH 後に backend が「description 変更を検出 → カロリー LLM 再推定」 を kick する。
      // user_corrected_description を空にして基本 description (AI 推定 or manual 登録時) を活かす場合と
      // user_corrected_description で上書きする場合があるが、 シンプルに常に user_corrected を使う。
      await api(`/api/meals/${mealId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_corrected_description: v,
          // 内容が変わったらユーザ補正カロリーをクリアして自動再推定させる
          user_corrected_calories: null,
        }),
      });
      await loadMeals();
    } catch (e) {
      alert(`内容保存エラー: ${e.message}`);
      restore();
    }
  }

  btn.querySelector('.meal-inline-save')?.addEventListener('click', (ev) => { ev.stopPropagation(); save(); });
  btn.querySelector('.meal-inline-cancel')?.addEventListener('click', (ev) => { ev.stopPropagation(); restore(); });
  ta?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save(); }
    if (ev.key === 'Escape') { ev.preventDefault(); restore(); }
  });
  ta?.addEventListener('click', (ev) => ev.stopPropagation());
}

// ── 場所 inline 編集 (lat,lon + 「現在地から」 + 「クリア」) ─────
function startMealLocationEdit(btn) {
  if (btn.classList.contains('editing')) return;
  const mealId = Number(btn.dataset.id);
  const curLat = btn.dataset.lat || '';
  const curLon = btn.dataset.lon || '';
  btn.classList.add('editing');
  const original = btn.innerHTML;
  btn.innerHTML = `
    <input type="number" step="any" class="meal-loc-lat" placeholder="緯度" value="${escapeHtml(curLat)}" />
    <input type="number" step="any" class="meal-loc-lon" placeholder="経度" value="${escapeHtml(curLon)}" />
    <span class="meal-inline-actions">
      <button class="meal-loc-here" type="button" title="現在地から取得">📍</button>
      <button class="meal-loc-clear" type="button" title="場所を削除">∅</button>
      <button class="meal-inline-save" type="button" title="保存">✓</button>
      <button class="meal-inline-cancel" type="button" title="キャンセル">×</button>
    </span>
  `;
  const latIn = btn.querySelector('.meal-loc-lat');
  const lonIn = btn.querySelector('.meal-loc-lon');

  function restore() { btn.innerHTML = original; btn.classList.remove('editing'); }

  async function save() {
    const lat = (latIn?.value ?? '').trim() === '' ? null : Number(latIn.value);
    const lon = (lonIn?.value ?? '').trim() === '' ? null : Number(lonIn.value);
    const body = { lat: null, lon: null };
    if (lat != null && lon != null && isFinite(lat) && isFinite(lon)) {
      body.lat = lat; body.lon = lon;
    }
    try {
      await api(`/api/meals/${mealId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await loadMeals();
    } catch (e) {
      alert(`場所保存エラー: ${e.message}`);
      restore();
    }
  }

  btn.querySelector('.meal-loc-here')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!navigator.geolocation) { alert('この端末は位置情報に対応していません'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (latIn) latIn.value = String(pos.coords.latitude);
        if (lonIn) lonIn.value = String(pos.coords.longitude);
      },
      (err) => alert(`位置取得失敗: ${err.message}`),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  });
  btn.querySelector('.meal-loc-clear')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (latIn) latIn.value = '';
    if (lonIn) lonIn.value = '';
  });
  btn.querySelector('.meal-inline-save')?.addEventListener('click', (ev) => { ev.stopPropagation(); save(); });
  btn.querySelector('.meal-inline-cancel')?.addEventListener('click', (ev) => { ev.stopPropagation(); restore(); });
  [latIn, lonIn].forEach((el) => {
    el?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); save(); }
      if (ev.key === 'Escape') { ev.preventDefault(); restore(); }
    });
    el?.addEventListener('click', (ev) => ev.stopPropagation());
  });
}

async function addMealAddition(mealId) {
  const name = prompt('追加で食べたものは? (例: アイスクリーム)');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const calRaw = prompt('カロリー (kcal、 不明なら空欄)', '');
  if (calRaw === null) return;
  const body = { name: trimmed };
  if (calRaw.trim() !== '') {
    const n = Number(calRaw);
    if (isFinite(n)) body.calories = n;
  }
  try {
    await api(`/api/meals/${mealId}/additions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await loadMeals();
  } catch (e) {
    alert(`追加エラー: ${e.message}`);
  }
}

async function editMealAddition(mealId, idx) {
  const m = mealsState.items.find((x) => x.id === mealId);
  if (!m) return;
  const additions = parseMealAdditions(m.additions_json);
  const cur = additions[idx];
  if (!cur) return;
  const name = prompt('項目名', cur.name || '');
  if (name === null) return;
  const calRaw = prompt('カロリー (kcal、 空欄でクリア)', cur.calories == null ? '' : String(cur.calories));
  if (calRaw === null) return;
  const body = {};
  if (name.trim()) body.name = name.trim();
  if (calRaw.trim() === '') body.calories = null;
  else {
    const n = Number(calRaw);
    if (isFinite(n)) body.calories = n;
  }
  try {
    await api(`/api/meals/${mealId}/additions/${idx}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await loadMeals();
  } catch (e) {
    alert(`編集エラー: ${e.message}`);
  }
}

async function deleteMealAddition(mealId, idx) {
  if (!confirm('この追加項目を削除しますか?')) return;
  try {
    await api(`/api/meals/${mealId}/additions/${idx}`, { method: 'DELETE' });
    await loadMeals();
  } catch (e) {
    alert(`削除エラー: ${e.message}`);
  }
}

// ── イベント結線 ─────────────────────────────────────────────
document.getElementById('mealsRefresh')?.addEventListener('click', () => loadMeals());

document.getElementById('mealsPhotoInput')?.addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length === 0) return;
  startMealModalForFiles(files);
});

document.getElementById('mealsCameraInput')?.addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length === 0) return;
  startMealModalForFiles(files);
});

document.getElementById('mealsManualBtn')?.addEventListener('click', () => startMealModalForManual());

// ── 食事モーダルのボタン結線 ──────────────────────────────────
document.getElementById('mealModalSubmit')?.addEventListener('click', () => submitMealModal());
document.getElementById('mealModalCancel')?.addEventListener('click', () => cancelMealModal());
document.getElementById('mealModalClose')?.addEventListener('click', () => cancelMealModal());
document.getElementById('mealModalSkip')?.addEventListener('click', () => skipMealModalItem());
document.querySelector('#mealModal .meal-modal-backdrop')?.addEventListener('click', () => cancelMealModal());
document.getElementById('mealModalLocHere')?.addEventListener('click', () => {
  if (!navigator.geolocation) { alert('この端末は位置情報に対応していません'); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setMealModalLatLon(pos.coords.latitude, pos.coords.longitude, /*recenter*/ true);
    },
    (err) => alert(`位置取得失敗: ${err.message}`),
    { enableHighAccuracy: true, timeout: 10_000 },
  );
});
document.getElementById('mealModalLocClear')?.addEventListener('click', () => {
  const latEl = document.getElementById('mealModalLat');
  const lonEl = document.getElementById('mealModalLon');
  if (latEl) latEl.value = '';
  if (lonEl) lonEl.value = '';
  clearMealModalMarker();
  updateMealModalMapLink();
});

// 🗺 地図ボタンで開閉 + 必要なら Google Maps を初期化
document.getElementById('mealModalMapToggle')?.addEventListener('click', async () => {
  const wrap = document.getElementById('mealModalMap');
  if (!wrap) return;
  const open = wrap.classList.toggle('hidden');
  if (open) return; // 閉じた
  const latEl = document.getElementById('mealModalLat');
  const lonEl = document.getElementById('mealModalLon');
  const lat = latEl?.value ? Number(latEl.value) : null;
  const lon = lonEl?.value ? Number(lonEl.value) : null;
  await ensureMealModalMap(lat, lon);
  // resize trigger (hidden → show のとき必須)
  if (mealMapState.map && window.google?.maps) {
    setTimeout(() => google.maps.event.trigger(mealMapState.map, 'resize'), 50);
  }
});

// lat/lon 手入力時に map と link を追従
['mealModalLat', 'mealModalLon'].forEach((id) => {
  document.getElementById(id)?.addEventListener('input', () => {
    const lat = Number(document.getElementById('mealModalLat')?.value);
    const lon = Number(document.getElementById('mealModalLon')?.value);
    if (isFinite(lat) && isFinite(lon)) {
      placeMealModalMarker(lat, lon);
    } else {
      clearMealModalMarker();
    }
    updateMealModalMapLink();
  });
});

// <dialog> のネイティブ close (Esc 含む) を cancel として扱う
document.getElementById('mealModal')?.addEventListener('close', () => {
  // showModal で開いた場合、 Esc で close → ここに来る
  if (mealModalState.queue.length > 0 || mealModalState.current) {
    clearMealQueue();
  }
});

// 単一日付フィルタの結線 (絞り込み変更で即時 reload + クリアボタン)
document.getElementById('mealsFilterDate')?.addEventListener('change', () => loadMeals());
document.getElementById('mealsFilterClear')?.addEventListener('click', () => {
  const el = document.getElementById('mealsFilterDate');
  if (el) el.value = '';
  loadMeals();
});

// ── 単語リングメニュー ────────────────────────────────────────
//
// グラフ / ワードクラウドの単語をクリックすると、 黒背景の上に
// 単語を中心としたリング状のボタン (ディグる / 辞書登録 / 削除) が
// 浮く。 削除は user_stopwords (server) に保存し、 既存の表示からは
// userStopwordSet で hide。

const wordRingState = {
  word: null,
  context: null, // { session?, onDig? }
};
const userStopwordSet = new Set();

async function loadUserStopwords() {
  try {
    const r = await api('/api/stopwords');
    userStopwordSet.clear();
    for (const it of (r.items || [])) userStopwordSet.add(String(it.lower || it.word || '').toLowerCase());
  } catch {
    // 無視 — 失敗しても致命的ではない
  }
}

function isUserStopword(word) {
  if (!word) return false;
  return userStopwordSet.has(String(word).toLowerCase());
}

function openWordRingMenu(word, clientX, clientY, ctx = {}) {
  const menu = document.getElementById('wordRingMenu');
  const wEl = document.getElementById('wordRingWord');
  const pop = menu?.querySelector('.word-ring-pop');
  if (!menu || !wEl || !pop) return;
  wordRingState.word = String(word || '').trim();
  wordRingState.context = ctx;
  wEl.textContent = wordRingState.word;

  // ポップ位置: クリック座標を中心に。 端だと画面外へ出るので clamp
  const W = window.innerWidth;
  const H = window.innerHeight;
  const PAD = 130; // pop の半径 (110) + 余白
  const cx = Math.max(PAD, Math.min(W - PAD, Number.isFinite(clientX) ? clientX : W / 2));
  const cy = Math.max(PAD, Math.min(H - PAD, Number.isFinite(clientY) ? clientY : H / 2));
  pop.style.left = `${cx}px`;
  pop.style.top = `${cy}px`;

  menu.classList.remove('hidden');
}

function closeWordRingMenu() {
  const menu = document.getElementById('wordRingMenu');
  if (menu) menu.classList.add('hidden');
  wordRingState.word = null;
  wordRingState.context = null;
}

async function wordRingAction(action) {
  const word = wordRingState.word;
  const ctx = wordRingState.context || {};
  closeWordRingMenu();
  if (!word) return;

  if (action === 'dig') {
    if (typeof ctx.onDig === 'function') {
      ctx.onDig(word);
    } else {
      // dig session 文脈の場合は textarea にプリフィル
      digOnWordPick(ctx.session || null, word);
    }
    return;
  }

  if (action === 'dict') {
    try {
      const r = await api('/api/dictionary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term: word }),
      });
      const msg = r.existed
        ? `「${word}」 は既に辞書に登録済 (id ${r.id})`
        : `📖 「${word}」 を辞書に登録しました`;
      // 辞書タブに反映 + 通知
      flashMessage(msg);
    } catch (e) {
      alert(`辞書登録エラー: ${e.message}`);
    }
    return;
  }

  if (action === 'delete') {
    if (!confirm(`「${word}」 を今後表示しない (stopword) ように設定しますか?`)) return;
    try {
      await api('/api/stopwords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word }),
      });
      userStopwordSet.add(word.toLowerCase());
      // 即時 hide: 該当 dataset.word を持つノード / cloud-word を CSS で隠す
      hideWordsInDom(word);
      flashMessage(`🗑 「${word}」 を以後の表示から除外しました`);
    } catch (e) {
      alert(`stopword 追加エラー: ${e.message}`);
    }
    return;
  }
}

function hideWordsInDom(word) {
  const lower = String(word || '').toLowerCase();
  document.querySelectorAll('[data-word]').forEach((el) => {
    if (String(el.dataset.word || '').toLowerCase() === lower) {
      el.style.display = 'none';
    }
  });
}

function flashMessage(text) {
  // 軽量な toast (既存 .share-toast 流用)
  const div = document.createElement('div');
  div.className = 'share-toast';
  div.textContent = text;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 3500);
}

// イベント結線
document.addEventListener('DOMContentLoaded', () => {
  // 起動時に user stopwords をロード
  loadUserStopwords();
});

document.getElementById('wordRingMenu')?.querySelectorAll('.word-ring-btn').forEach((btn) => {
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const action = btn.dataset.action;
    if (action) wordRingAction(action);
  });
});
document.getElementById('wordRingClose')?.addEventListener('click', () => closeWordRingMenu());
document.querySelector('#wordRingMenu .word-ring-backdrop')?.addEventListener('click', () => closeWordRingMenu());
window.addEventListener('keydown', (ev) => {
  const menu = document.getElementById('wordRingMenu');
  if (menu && !menu.classList.contains('hidden') && ev.key === 'Escape') {
    ev.preventDefault();
    closeWordRingMenu();
  }
});

// 起動時にも一度ロード (DOMContentLoaded を待たないコード経路用)
loadUserStopwords();
