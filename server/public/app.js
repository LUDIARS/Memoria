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
  ragStatus: null,
  ragResults: [],
  ragAnswer: null,
  digSession: null,
  digHistory: [],
  digSelected: new Set(),
  digPolling: null,
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
      load();
    });
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
    const badge = $('queueBadge');
    const tabCount = $('tabQueueCount');
    if (snap.depth > 0) {
      badge.classList.remove('hidden');
      tabCount.classList.remove('hidden');
      $('queueCount').textContent = snap.depth;
      tabCount.textContent = snap.depth;
    } else {
      badge.classList.add('hidden');
      tabCount.classList.add('hidden');
    }
    if (state.tab === 'queue') renderQueue();
    return snap.depth;
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

function renderQueue() {
  // Now running
  const runEl = $('queueRunning');
  const items = state.queue.items || [];
  const head = items[0]?.status === 'running' ? items[0] : null;
  if (head) {
    const elapsed = head.startedAt ? Date.now() - head.startedAt : 0;
    runEl.classList.remove('empty');
    runEl.innerHTML = `
      <div class="row">
        <div class="pulse"></div>
        <div style="flex:1; min-width:0">
          <div class="title">${escapeHtml(head.title || `id=${head.bookmarkId}`)}</div>
          <div class="url">${escapeHtml(head.url || '')}</div>
          <div class="meta">経過 ${fmtElapsed(elapsed)} · seq #${head.seq}</div>
        </div>
      </div>
    `;
  } else {
    runEl.classList.add('empty');
    runEl.textContent = '実行中のジョブはありません';
  }

  // Queued (skip the running head)
  const queued = items.filter(i => i.status === 'queued');
  $('queueQueuedCount').textContent = queued.length;
  const queuedEl = $('queueQueued');
  if (queued.length === 0) {
    queuedEl.innerHTML = '<div class="queue-empty">順番待ちはありません</div>';
  } else {
    queuedEl.innerHTML = queued.map(i => `
      <li>
        <div class="title">${escapeHtml(i.title || `id=${i.bookmarkId}`)}</div>
        <div class="url">${escapeHtml(i.url || '')}</div>
      </li>
    `).join('');
  }

  // History
  const hist = state.queue.history || [];
  $('queueHistoryCount').textContent = hist.length;
  const histEl = $('queueHistory');
  if (hist.length === 0) {
    histEl.innerHTML = '<div class="queue-empty">履歴はありません</div>';
  } else {
    histEl.innerHTML = hist.map(i => {
      const dur = i.startedAt && i.finishedAt ? i.finishedAt - i.startedAt : null;
      const ok = i.status === 'done';
      return `
        <li>
          <div class="icon ${ok ? 'done' : 'error'}">${ok ? '✓' : '✗'}</div>
          <div style="min-width:0">
            <div class="title">${escapeHtml(i.title || `id=${i.bookmarkId}`)}</div>
            <div class="url">${escapeHtml(i.url || '')}</div>
            ${i.error ? `<div class="err">${escapeHtml(i.error)}</div>` : ''}
          </div>
          <div class="duration">
            ${fmtElapsed(dur)}<br>
            ${i.finishedAt ? new Date(i.finishedAt).toLocaleTimeString() : ''}
          </div>
        </li>
      `;
    }).join('');
  }
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  $('bookmarksView').classList.toggle('hidden', tab !== 'bookmarks');
  $('queueView').classList.toggle('hidden', tab !== 'queue');
  $('visitsView').classList.toggle('hidden', tab !== 'visits');
  $('trendsView').classList.toggle('hidden', tab !== 'trends');
  $('recommendView').classList.toggle('hidden', tab !== 'recommend');
  $('ragView').classList.toggle('hidden', tab !== 'rag');
  $('digView').classList.toggle('hidden', tab !== 'dig');
  if (tab === 'queue') renderQueue();
  if (tab === 'visits') loadVisits();
  if (tab === 'trends') loadTrends();
  if (tab === 'recommend') loadRecommendations();
  if (tab === 'rag') loadRagStatus();
  if (tab === 'dig') loadDigHistory();
}

// ── Dig (deep research) ──────────────────────────────────────────────────

async function loadDigHistory() {
  try {
    const { items } = await api('/api/dig');
    state.digHistory = items;
    renderDigHistory();
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

async function startDig() {
  const q = $('digQuery').value.trim();
  if (!q) return;
  $('digRun').disabled = true;
  $('digRun').textContent = '掘削中…';
  try {
    const r = await api('/api/dig', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
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
  state.digPolling = setInterval(async () => {
    const s = await api(`/api/dig/${id}`).catch(() => null);
    if (!s) return;
    if (s.status !== 'pending') {
      clearInterval(state.digPolling);
      state.digPolling = null;
      state.digSession = s;
      renderDigSession();
      loadDigHistory();
    }
  }, 5000);
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
  if (!s) { el.innerHTML = ''; return; }
  if (s.status === 'pending') {
    el.innerHTML = `<div class="dig-pending"><div class="pulse"></div>「${escapeHtml(s.query)}」を掘っています…claude が Web 検索 + 取得を行うため数十秒〜数分かかります。</div>`;
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
  el.innerHTML = `
    ${summaryBlock}
    ${graph}
    <div class="dig-actions">
      <span id="digSelCount">0</span> 件選択中
      <span class="grow"></span>
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

// ── RAG ────────────────────────────────────────────────────────────────

async function loadRagStatus() {
  try {
    const s = await api('/api/rag/status');
    state.ragStatus = s;
    renderRagStatus();
  } catch (e) {
    $('ragStatus').textContent = `RAG: ${e.message}`;
  }
}

function renderRagStatus() {
  const s = state.ragStatus;
  const el = $('ragStatus');
  if (!s) { el.textContent = '読み込み中…'; return; }
  if (!s.enabled) {
    el.innerHTML = '<span class="pill">disabled</span> RAG は無効化されています (MEMORIA_RAG=0)。';
    return;
  }
  const idx = `${s.indexed_bookmarks}/${s.indexed_bookmarks + s.pending_bookmarks} ブックマーク (${s.total_chunks} チャンク)`;
  const queued = s.queue_depth > 0 ? ` · 埋め込み中 ${s.queue_depth}` : '';
  el.innerHTML = `
    <span class="pill">${escapeHtml(s.model)}</span>
    インデックス: ${idx}${queued}
    ${s.pending_bookmarks > 0 ? '<button id="ragBackfillBtn">未処理を全部キュー投入</button>' : ''}
  `;
  const btn = document.getElementById('ragBackfillBtn');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '投入中…';
      try {
        const r = await api('/api/rag/backfill', { method: 'POST' });
        alert(`${r.queued} 件をキューに投入しました。完了まで時間がかかります。`);
        loadRagStatus();
      } catch (e) { alert(`失敗: ${e.message}`); }
    });
  }
}

async function ragSearch() {
  const q = $('ragQuery').value.trim();
  if (!q) return;
  $('ragResults').innerHTML = '<div class="queue-empty">検索中…</div>';
  $('ragAnswer').classList.add('hidden');
  try {
    const r = await api(`/api/search?q=${encodeURIComponent(q)}&limit=12`);
    state.ragResults = r.items || [];
    renderRagResults(r.note);
  } catch (e) {
    $('ragResults').innerHTML = `<div class="queue-empty">エラー: ${escapeHtml(e.message)}</div>`;
  }
}

function renderRagResults(note) {
  const items = state.ragResults;
  if (items.length === 0) {
    $('ragResults').innerHTML = `<div class="queue-empty">${escapeHtml(note || '一致するブックマークがありません。')}</div>`;
    return;
  }
  $('ragResults').innerHTML = items.map(it => `
    <div class="rag-result" data-id="${it.bookmark_id}">
      <div>
        <div class="title">${escapeHtml(it.title)}</div>
        <div class="url"><a href="${escapeHtml(it.url)}" target="_blank" rel="noreferrer">${escapeHtml(it.url)}</a></div>
        <div class="chunk">${escapeHtml(it.chunk || '')}</div>
      </div>
      <div class="score">${(it.score * 100).toFixed(1)}%</div>
    </div>
  `).join('');
  $('ragResults').querySelectorAll('.rag-result').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      openDetail(Number(card.dataset.id));
      switchTab('bookmarks');
    });
  });
}

async function ragAsk() {
  const q = $('ragQuery').value.trim();
  if (!q) return;
  const ans = $('ragAnswer');
  ans.classList.remove('hidden');
  ans.innerHTML = '<h4>Answer</h4>考え中…';
  try {
    const r = await api('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q }),
    });
    ans.innerHTML = `
      <h4>Answer</h4>
      ${escapeHtml(r.answer)}
      <div class="citations">
        ${(r.sources || []).map(s => `[Source ${s.id}] <a href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">${escapeHtml(s.title)}</a>`).join(' &nbsp; ')}
      </div>
    `;
  } catch (e) {
    ans.innerHTML = `<h4>Error</h4>${escapeHtml(e.message)}`;
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
    const [cats, diff, timeline, domains] = await Promise.all([
      api(`/api/trends/categories?days=${encodeURIComponent(days)}`),
      api(`/api/trends/category-diff?days=7`),
      api(`/api/trends/timeline?days=${encodeURIComponent(days)}`),
      api(`/api/trends/domains?days=${encodeURIComponent(days)}`),
    ]);
    renderTrendCategories(cats.items);
    renderTrendDiff(diff.items);
    renderTrendTimeline(timeline.items);
    renderTrendDomains(domains.items);
  } catch (e) {
    console.error('trends load failed', e);
  }
}

function renderTrendCategories(items) {
  $('trendCategories').innerHTML = svgHorizontalBar(items, c => c.category, c => c.count);
}

function renderTrendDomains(items) {
  $('trendDomains').innerHTML = svgHorizontalBar(items, c => c.domain, c => c.hits, 'alt');
}

function svgHorizontalBar(items, labelFn, valueFn, klass = '') {
  if (!items.length) return '<div class="queue-empty">データなし</div>';
  const max = Math.max(...items.map(valueFn), 1);
  const rowH = 22, padTop = 4, padLeft = 130, padRight = 40, w = 460;
  const h = padTop * 2 + items.length * rowH;
  const rows = items.map((it, i) => {
    const v = valueFn(it);
    const len = Math.round((v / max) * (w - padLeft - padRight));
    const y = padTop + i * rowH;
    const label = String(labelFn(it)).slice(0, 18);
    return `
      <text class="label" x="${padLeft - 8}" y="${y + 14}" text-anchor="end">${escapeHtml(label)}</text>
      <rect class="bar ${klass}" x="${padLeft}" y="${y + 4}" width="${len}" height="14" rx="2" />
      <text class="label" x="${padLeft + len + 6}" y="${y + 14}">${v}</text>
    `;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMinYMin meet">${rows}</svg>`;
}

function renderTrendTimeline(items) {
  if (!items.length) { $('trendTimeline').innerHTML = '<div class="queue-empty">データなし</div>'; return; }
  const w = 600, h = 200, padL = 32, padR = 12, padT = 12, padB = 24;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const max = Math.max(1, ...items.flatMap(d => [d.saves, d.accesses]));
  const xStep = innerW / Math.max(1, items.length - 1);
  function pts(key) {
    return items.map((d, i) => {
      const x = padL + i * xStep;
      const y = padT + innerH - (d[key] / max) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }
  function dots(key, klass) {
    return items.map((d, i) => {
      const x = padL + i * xStep;
      const y = padT + innerH - (d[key] / max) * innerH;
      return `<circle class="${klass}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" />`;
    }).join('');
  }
  // Y axis labels (0, max/2, max)
  const yLabels = [0, Math.round(max / 2), max].map(v => {
    const y = padT + innerH - (v / max) * innerH;
    return `<text class="label" x="${padL - 6}" y="${y + 3}" text-anchor="end">${v}</text>
            <line class="grid" x1="${padL}" y1="${y}" x2="${padL + innerW}" y2="${y}" />`;
  }).join('');
  const xLabelStep = Math.max(1, Math.floor(items.length / 6));
  const xLabels = items.map((d, i) => {
    if (i % xLabelStep !== 0 && i !== items.length - 1) return '';
    const x = padL + i * xStep;
    const md = d.date.slice(5);
    return `<text class="label" x="${x.toFixed(1)}" y="${h - 6}" text-anchor="middle">${md}</text>`;
  }).join('');
  $('trendTimeline').innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMinYMin meet">
      ${yLabels}
      <polyline class="line-saves" points="${pts('saves')}" />
      <polyline class="line-accesses" points="${pts('accesses')}" />
      ${dots('saves', 'dot')}
      ${dots('accesses', 'dot-alt')}
      ${xLabels}
    </svg>
    <div class="chart-legend">
      <span><span class="dot saves"></span>新規保存</span>
      <span><span class="dot accesses"></span>アクセス</span>
    </div>
  `;
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
    return `
      <li class="${sel ? 'selected' : ''} ${hot ? 'hot' : ''}" data-url="${escapeHtml(v.url)}">
        <input type="checkbox" class="vchk" ${sel ? 'checked' : ''} />
        <div style="min-width:0">
          <div class="title">${escapeHtml(v.title || '(タイトル未取得)')} ${badge}</div>
          <div class="url">${escapeHtml(v.url)}</div>
          <div class="visits-meta">${escapeHtml(dom)}${v.score ? ` · score ${v.score}` : ''}</div>
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

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

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
$('digRun').addEventListener('click', startDig);
$('digQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); startDig(); }
});
$('ragSearchBtn').addEventListener('click', ragSearch);
$('ragAskBtn').addEventListener('click', ragAsk);
$('ragQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    ragSearch();
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
