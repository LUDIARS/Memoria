// Memoria content script — page-aware floating button stack.
//
// 通常ページ: 青の保存ボタン 1 つ
// AI chat ドメイン (chatgpt/claude/gemini): 紫の Note 化ボタンを追加
// 実装自慢キーワード一致 (github.com × LUDIARS 等): 黄の「実装自慢として展開」 ボタン
// ショッピングドメイン (amazon 等): 緑の「ほしいものに追加」 ボタン
//
// ルール検出は background → /api/extension/rules で取得し、 page-load 時に判定。

(() => {
  const TAG = '[Memoria]';
  const HOST_ID = '__memoria_host';

  if (window.top !== window) {
    console.debug(TAG, 'skipping: inside iframe', location.href);
    return;
  }
  if (window.__memoriaInjected) {
    console.debug(TAG, 'already injected on this page');
    return;
  }
  window.__memoriaInjected = true;

  console.info(TAG, 'content script loaded on', location.href);

  whenReady(() => {
    try { mount(); }
    catch (e) { console.error(TAG, 'mount failed:', e); }
  });

  function whenReady(fn) {
    const ready = () => document.body || document.documentElement;
    if (ready()) return fn();
    document.addEventListener('DOMContentLoaded', () => fn(), { once: true });
  }

  // ── chat extractors (inlined — content scripts cannot use ESM imports) ──

  function extractChatMessages(source) {
    switch (source) {
      case 'chatgpt': return extractChatGpt();
      case 'claude': return extractClaude();
      case 'gemini': return extractGemini();
      default: return [];
    }
  }

  function extractChatGpt() {
    const out = [];
    const els = document.querySelectorAll('[data-message-author-role][data-message-id]');
    for (const el of els) {
      const role = el.getAttribute('data-message-author-role');
      const text = (el.textContent || '').trim();
      if (!text) continue;
      out.push({
        role: role === 'assistant' ? 'assistant' : (role === 'system' ? 'system' : 'user'),
        text,
      });
    }
    return out;
  }

  function extractClaude() {
    const out = [];
    const all = [...document.querySelectorAll('[data-testid="user-message"], [data-testid="message-content"]')];
    if (all.length > 0) {
      for (const el of all) {
        const role = el.getAttribute('data-testid') === 'user-message' ? 'user' : 'assistant';
        const text = (el.textContent || '').trim();
        if (text) out.push({ role, text });
      }
      return out;
    }
    const fallback = document.querySelectorAll('.font-claude-message, .font-user-message');
    for (const el of fallback) {
      const cls = el.className || '';
      const role = /user/i.test(cls) ? 'user' : 'assistant';
      const text = (el.textContent || '').trim();
      if (text) out.push({ role, text });
    }
    return out;
  }

  function extractGemini() {
    const out = [];
    const els = document.querySelectorAll('user-query, model-response');
    for (const el of els) {
      const tag = (el.tagName || '').toLowerCase();
      const role = tag === 'model-response' ? 'assistant' : 'user';
      const text = (el.textContent || '').trim();
      if (text) out.push({ role, text });
    }
    return out;
  }

  // ── Notion DOM scraper (best-effort: クラス名は変わりやすいので安全側) ──

  function extractNotionTitle() {
    const t = document.querySelector('h1.notion-page-title-text')
      || document.querySelector('[placeholder="Untitled"]');
    return ((t?.textContent || '').trim()) || document.title;
  }

  function extractNotionPageId() {
    const m = location.pathname.match(/([0-9a-f]{32})/i);
    return m ? m[1] : null;
  }

  function extractNotionBlocks() {
    const blocks = [];
    const root = document.querySelector('.notion-page-content')
      || document.querySelector('main')
      || document.body;
    if (!root) return blocks;

    const els = root.querySelectorAll('[data-block-id]');
    for (const el of els) {
      const cls = el.className || '';
      let kind = null;
      const extra = {};

      const editable = el.querySelector('[contenteditable="true"]');
      const text = ((editable?.textContent ?? el.textContent ?? '')).trim();

      if (cls.includes('notion-header-block')) kind = 'heading_1';
      else if (cls.includes('notion-sub_header-block')) kind = 'heading_2';
      else if (cls.includes('notion-sub_sub_header-block')) kind = 'heading_3';
      else if (cls.includes('notion-quote-block')) kind = 'quote';
      else if (cls.includes('notion-bulleted_list-block')) kind = 'bullet_list';
      else if (cls.includes('notion-numbered_list-block')) kind = 'numbered_list';
      else if (cls.includes('notion-to_do-block')) {
        kind = 'todo';
        const cb = el.querySelector('input[type="checkbox"]');
        extra.checked = cb ? cb.checked : false;
      } else if (cls.includes('notion-code-block')) {
        kind = 'code';
      } else if (cls.includes('notion-divider-block')) {
        kind = 'divider';
      } else if (cls.includes('notion-bookmark-block')) {
        // Notion `/bookmark` block: <a href> + title + caption + img。
        // server 側で bookmark_embed (URL カード) として保存される。
        const a = el.querySelector('a[href]');
        const url = a ? a.getAttribute('href') : '';
        if (!url) continue;
        const titleEl = el.querySelector('[class*="bookmark-title"]');
        const captionEl = el.querySelector('[class*="bookmark-description"]');
        const img = el.querySelector('img');
        blocks.push({
          kind: 'bookmark',
          url,
          title: titleEl ? titleEl.textContent.trim() : '',
          caption: captionEl ? captionEl.textContent.trim() : '',
          image: img ? img.getAttribute('src') : '',
        });
        continue;
      } else if (cls.includes('notion-text-block')) {
        kind = 'text';
      }

      if (!kind) continue;
      if (kind === 'divider') { blocks.push({ kind }); continue; }
      if (!text) continue;
      blocks.push({ kind, text, ...extra });
    }
    return blocks;
  }

  // ── dispatch detection (asks background for current rules + match) ──

  async function detectDispatch() {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'memoria.detectDispatch',
        url: location.href,
        host: location.host,
        title: document.title,
        bodyText: (document.body?.innerText || '').slice(0, 4000),
      });
      return res && Array.isArray(res.dispatches) ? res.dispatches : [];
    } catch (e) {
      console.warn(TAG, 'detect failed', e);
      return [];
    }
  }

  // ── mount ───────────────────────────────────────────────────────────────

  async function mount() {
    if (document.getElementById(HOST_ID)) return;
    const parent = document.body || document.documentElement;
    if (!parent) return;

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = [
      'position: fixed', 'left: 0', 'top: 0',
      'width: 0', 'height: 0', 'z-index: 2147483647',
      'pointer-events: none', 'margin: 0', 'padding: 0', 'border: 0',
    ].join(';') + ';';
    parent.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .stack {
          position: fixed; pointer-events: auto;
          font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif;
          display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
        }
        .btn {
          width: 44px; height: 44px;
          border-radius: 50%;
          color: #fff;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; user-select: none;
          box-shadow: 0 2px 10px rgba(0,0,0,0.35);
          transition: transform 0.05s, filter 0.2s;
          position: relative;
          touch-action: none;
          font-size: 18px;
        }
        .btn.primary { cursor: grab; }
        .btn.primary.dragging { cursor: grabbing; }
        .btn:hover { filter: brightness(0.92); }
        .btn:active { transform: scale(0.95); }
        .btn.busy { filter: grayscale(0.8); cursor: progress; }
        .btn.bookmark { background: #2a6df4; }
        .btn.bookmark.chat-tinted { background: #7b3ff2; }
        .btn.bookmark.notion-tinted { background: #1d2230; }
        .btn.chat { background: #7b3ff2; }
        .btn.notion { background: #1d2230; }
        .btn.impl { background: #f6b73c; color: #1d2230; }
        .btn.shopping { background: #3ac26a; }
        .btn svg { width: 20px; height: 20px; pointer-events: none; }
        .close {
          position: absolute; top: -6px; right: -6px;
          width: 18px; height: 18px; border-radius: 50%;
          background: rgba(0,0,0,0.65); color: #fff;
          font-size: 12px; line-height: 18px; text-align: center;
          cursor: pointer; opacity: 0; transition: opacity 0.2s;
        }
        .stack:hover .close { opacity: 1; }
        .toast {
          position: absolute; right: 0; bottom: -40px;
          background: rgba(20,20,20,0.92); color: #fff;
          padding: 6px 10px; border-radius: 6px;
          font-size: 12px; white-space: nowrap;
          opacity: 0; transform: translateY(4px);
          transition: opacity 0.25s, transform 0.25s;
          pointer-events: none;
          max-width: 280px;
          overflow: hidden; text-overflow: ellipsis;
        }
        .toast.show { opacity: 1; transform: translateY(0); }
        .toast.ok { background: rgba(40,140,80,0.92); }
        .toast.err { background: rgba(180,40,40,0.92); }
      </style>
      <div class="stack">
        <div class="dispatch-buttons"></div>
        <div class="btn primary bookmark" title="Memoria に保存">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
          </svg>
          <div class="close" title="このタブで非表示">×</div>
        </div>
        <div class="toast"></div>
      </div>
    `;

    const stack = root.querySelector('.stack');
    const btn = root.querySelector('.btn.primary');
    const close = root.querySelector('.close');
    const toast = root.querySelector('.toast');
    const dispatchBox = root.querySelector('.dispatch-buttons');

    // ---- position --------------------------------------------------------

    const DEFAULT_POS = { right: 24, bottom: 24 };
    let pos = { ...DEFAULT_POS };
    function applyPos() {
      stack.style.right = pos.right + 'px';
      stack.style.bottom = pos.bottom + 'px';
      stack.style.left = '';
      stack.style.top = '';
    }
    applyPos();
    try {
      chrome.storage?.sync.get({ buttonPos: DEFAULT_POS }, ({ buttonPos }) => {
        pos = buttonPos || DEFAULT_POS;
        applyPos();
      });
    } catch {}

    // ---- drag (primary button only) -------------------------------------

    let drag = null;
    const DRAG_THRESHOLD = 4;

    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target === close) return;
      try { btn.setPointerCapture(e.pointerId); } catch {}
      const r = stack.getBoundingClientRect();
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX, startY: e.clientY,
        origRight: window.innerWidth - r.right,
        origBottom: window.innerHeight - r.bottom,
        moved: false,
      };
      btn.classList.add('dragging');
      e.preventDefault();
    });
    btn.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) drag.moved = true;
      if (!drag.moved) return;
      pos = {
        right: clamp(drag.origRight - dx, 0, window.innerWidth - 44),
        bottom: clamp(drag.origBottom - dy, 0, window.innerHeight - 44),
      };
      applyPos();
    });
    btn.addEventListener('pointerup', () => {
      if (!drag) return;
      const wasDrag = drag.moved;
      try { btn.releasePointerCapture(drag.pointerId); } catch {}
      drag = null;
      btn.classList.remove('dragging');
      if (wasDrag) {
        try { chrome.storage?.sync.set({ buttonPos: pos }); } catch {}
      } else {
        saveCurrentPage();
      }
    });
    btn.addEventListener('pointercancel', () => {
      if (drag) { btn.classList.remove('dragging'); drag = null; }
    });

    close.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      host.remove();
    });

    // ---- dispatch detection ---------------------------------------------

    const dispatches = await detectDispatch();
    for (const d of dispatches) {
      if (d.kind === 'chat') {
        btn.classList.add('chat-tinted');
        addDispatchButton('chat', '🧠', `${d.source} のチャットを Note 化`, () => ingestChat(d.source));
      } else if (d.kind === 'notion') {
        btn.classList.add('notion-tinted');
        addDispatchButton('notion', '📒', 'Notion ページを Note 化', () => ingestNotion());
      } else if (d.kind === 'impl') {
        addDispatchButton('impl', '🚀', `実装自慢として展開 (${d.label})`, () => expandImpl());
      } else if (d.kind === 'shopping') {
        addDispatchButton('shopping', '🛒', `${d.label || d.host}: タスクに追加 (買い物)`, () => addWishlist());
      }
    }

    function addDispatchButton(kind, icon, title, onClick) {
      const b = document.createElement('div');
      b.className = `btn ${kind}`;
      b.title = title;
      b.textContent = icon;
      b.addEventListener('click', async () => {
        if (b.classList.contains('busy')) return;
        b.classList.add('busy');
        try { await onClick(); }
        finally { b.classList.remove('busy'); }
      });
      dispatchBox.appendChild(b);
    }

    // ---- actions ---------------------------------------------------------

    let busy = false;
    async function saveCurrentPage() {
      if (busy) return;
      busy = true;
      btn.classList.add('busy');
      showToast('保存中...');
      try {
        const payload = {
          url: location.href,
          title: document.title,
          html: document.documentElement.outerHTML,
        };
        const res = await chrome.runtime.sendMessage({ type: 'memoria.save', payload });
        if (res?.ok) {
          showToast(res.duplicate ? '保存済み (アクセスを記録)' : `保存しました (id=${res.id})`, 'ok');
        } else {
          showToast(`エラー: ${res?.error ?? '不明'}`, 'err');
        }
      } catch (e) { showToast(`エラー: ${e.message}`, 'err'); }
      finally { busy = false; btn.classList.remove('busy'); }
    }

    async function ingestChat(source) {
      showToast(`${source} の会話を取得中...`);
      const messages = extractChatMessages(source);
      if (messages.length === 0) {
        showToast('会話が見つかりませんでした (UI の DOM が変わった可能性)', 'err');
        return;
      }
      const conversationId = location.pathname.split('/').filter(Boolean).pop() || null;
      // 並列で Note 化 + bookmark 保存
      const [noteRes, bmRes] = await Promise.all([
        chrome.runtime.sendMessage({
          type: 'memoria.saveChat',
          payload: {
            source,
            url: location.href,
            conversation_id: conversationId,
            title: document.title,
            messages,
            also_create_note: true,
          },
        }),
        chrome.runtime.sendMessage({
          type: 'memoria.save',
          payload: {
            url: location.href,
            title: document.title,
            html: document.documentElement.outerHTML,
          },
        }),
      ]);
      const saved = noteRes?.messages_saved ?? 0;
      const noteId = noteRes?.note?.id;
      if (noteRes?.ok && noteId) {
        showToast(`Note 化 (${saved} 件) + bookmark 保存`, 'ok');
      } else if (noteRes?.ok) {
        showToast(`セッションログのみ保存 (${saved} 件)`, 'ok');
      } else {
        showToast(`エラー: ${noteRes?.error ?? '不明'}`, 'err');
      }
      void bmRes;
    }

    async function ingestNotion() {
      showToast('Notion ページを取り込み中...');
      const blocks = extractNotionBlocks();
      if (blocks.length === 0) {
        showToast('Notion ブロックを抽出できませんでした (DOM 構造が変わった可能性)', 'err');
        return;
      }
      const title = extractNotionTitle();
      const pageId = extractNotionPageId();
      const res = await chrome.runtime.sendMessage({
        type: 'memoria.saveNotion',
        payload: {
          url: location.href,
          page_id: pageId,
          title,
          blocks,
          also_bookmark: true,
        },
      });
      if (res?.ok) {
        const n = blocks.length;
        showToast(`Note 化完了 (${n} ブロック取り込み)`, 'ok');
      } else {
        showToast(`エラー: ${res?.error ?? '不明'}`, 'err');
      }
    }

    async function expandImpl() {
      const res = await chrome.runtime.sendMessage({
        type: 'memoria.expandImpl',
        payload: {
          url: location.href,
          title: document.title,
          host: location.host,
        },
      });
      if (res?.ok) showToast(`実装自慢ドラフト作成 (id=${res.id})`, 'ok');
      else showToast(`エラー: ${res?.error ?? '不明'}`, 'err');
    }

    async function addWishlist() {
      const res = await chrome.runtime.sendMessage({
        type: 'memoria.addWishlist',
        payload: {
          url: location.href,
          title: document.title,
        },
      });
      if (res?.ok) showToast(`「買い物」 タスクに追加 (id=${res.id})`, 'ok');
      else showToast(`エラー: ${res?.error ?? '不明'}`, 'err');
    }

    // ---- toast / utils ---------------------------------------------------

    let toastTimer = null;
    function showToast(msg, kind = '') {
      toast.textContent = msg;
      toast.className = `toast show ${kind}`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3500);
    }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    window.addEventListener('resize', () => {
      pos.right = clamp(pos.right, 0, window.innerWidth - 44);
      pos.bottom = clamp(pos.bottom, 0, window.innerHeight - 44);
      applyPos();
    });

    chrome.storage?.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.buttonPos?.newValue) {
        pos = changes.buttonPos.newValue;
        applyPos();
      }
    });
  }
})();
