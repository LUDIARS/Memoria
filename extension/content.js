// Floating "Save to Memoria" button. Runs in the content script isolated world.
// - Single click → save the current page
// - Drag → reposition (saved to chrome.storage.sync)
// - Hover and click × → hide for the current tab session

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

  // Wait for a real parent we can append into. document_idle usually means body
  // exists, but be defensive for SVG/XML/early-error pages.
  whenReady(() => {
    try {
      mount();
    } catch (e) {
      console.error(TAG, 'mount failed:', e);
    }
  });

  function whenReady(fn) {
    const ready = () => document.body || document.documentElement;
    if (ready()) return fn();
    document.addEventListener('DOMContentLoaded', () => fn(), { once: true });
  }

  function mount() {
    if (document.getElementById(HOST_ID)) {
      console.debug(TAG, 'host already in DOM, skipping');
      return;
    }

    const parent = document.body || document.documentElement;
    if (!parent) {
      console.warn(TAG, 'no parent to mount into');
      return;
    }

    const host = document.createElement('div');
    host.id = HOST_ID;
    // The host itself is a positioned 0-size container; the visible button
    // is rendered inside Shadow DOM so the page CSS can't bleed in.
    host.style.cssText = [
      'position: fixed',
      'left: 0',
      'top: 0',
      'width: 0',
      'height: 0',
      'z-index: 2147483647',
      'pointer-events: none',
      'margin: 0',
      'padding: 0',
      'border: 0',
    ].join(';') + ';';
    parent.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          position: fixed;
          pointer-events: auto;
          font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif;
        }
        .btn {
          width: 44px; height: 44px;
          border-radius: 50%;
          background: #2a6df4;
          color: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: grab;
          box-shadow: 0 2px 10px rgba(0,0,0,0.35);
          user-select: none;
          transition: background 0.2s, transform 0.05s;
          position: relative;
          touch-action: none;
        }
        .btn:hover { background: #1f56c0; }
        .btn:active { transform: scale(0.95); }
        .btn.dragging { cursor: grabbing; transition: none; }
        .btn.busy { background: #888; cursor: progress; }
        .btn svg { width: 22px; height: 22px; pointer-events: none; }
        .close {
          position: absolute;
          top: -6px; right: -6px;
          width: 18px; height: 18px;
          border-radius: 50%;
          background: rgba(0,0,0,0.65);
          color: white;
          font-size: 12px;
          line-height: 18px;
          text-align: center;
          cursor: pointer;
          opacity: 0;
          transition: opacity 0.2s;
          user-select: none;
        }
        .wrap:hover .close { opacity: 1; }
        .toast {
          position: absolute;
          right: 0;
          bottom: 52px;
          background: rgba(20,20,20,0.92);
          color: white;
          padding: 6px 10px;
          border-radius: 6px;
          font-size: 12px;
          white-space: nowrap;
          opacity: 0;
          transform: translateY(4px);
          transition: opacity 0.25s, transform 0.25s;
          pointer-events: none;
        }
        .toast.show { opacity: 1; transform: translateY(0); }
        .toast.ok { background: rgba(40,140,80,0.92); }
        .toast.err { background: rgba(180,40,40,0.92); }
      </style>
      <div class="wrap">
        <div class="btn" title="Memoria に保存 (ドラッグで移動)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
          </svg>
          <div class="close" title="このタブで非表示">×</div>
        </div>
        <div class="toast"></div>
      </div>
    `;

    const wrap = root.querySelector('.wrap');
    const btn = root.querySelector('.btn');
    const close = root.querySelector('.close');
    const toast = root.querySelector('.toast');

    // ---- position --------------------------------------------------------

    const DEFAULT_POS = { right: 24, bottom: 24 };
    let pos = { ...DEFAULT_POS };

    function applyPos() {
      wrap.style.right = pos.right + 'px';
      wrap.style.bottom = pos.bottom + 'px';
      wrap.style.left = '';
      wrap.style.top = '';
    }
    applyPos();

    try {
      chrome.storage?.sync.get({ buttonPos: DEFAULT_POS }, ({ buttonPos }) => {
        pos = buttonPos || DEFAULT_POS;
        applyPos();
      });
    } catch (e) {
      console.warn(TAG, 'storage unavailable, using default position', e);
    }

    // ---- drag ------------------------------------------------------------

    let drag = null;
    const DRAG_THRESHOLD = 4;

    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target === close) return;
      try { btn.setPointerCapture(e.pointerId); } catch {}
      const r = wrap.getBoundingClientRect();
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
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
      const newRight = clamp(drag.origRight - dx, 0, window.innerWidth - 44);
      const newBottom = clamp(drag.origBottom - dy, 0, window.innerHeight - 44);
      pos = { right: newRight, bottom: newBottom };
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
      console.info(TAG, 'hidden by user for this tab');
    });

    // ---- save action -----------------------------------------------------

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
      } catch (e) {
        showToast(`エラー: ${e.message}`, 'err');
      } finally {
        busy = false;
        btn.classList.remove('busy');
      }
    }

    let toastTimer = null;
    function showToast(msg, kind = '') {
      toast.textContent = msg;
      toast.className = `toast show ${kind}`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3000);
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

    console.info(TAG, 'mounted floating button at', pos);
  }
})();
