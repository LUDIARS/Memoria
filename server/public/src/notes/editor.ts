// Note エディタ — ブロックベース WYSIWYG。
//
// DOM 構造 (notesView 内):
//   .notes-layout
//     .notes-sidebar    ← ノート一覧 + 新規作成 + 検索
//     .notes-pane       ← 詳細 (タイトル + ブロック群)
//
// 各ブロックは contenteditable で、 blur で auto-save。
// `/` 入力 (空行) で slash menu (ブロック種別切替) が出る。
// テキスト選択時は floating toolbar (B / I / 🎨色 / link)。

import * as api from './api.js';
import type {
  NoteBlockRow, NoteBlockType, NoteSummary, NoteWithBlocks, BlockData,
} from './types.js';
import { renderInline } from './markdown.js';
import { sanitizeInlineHtml, escapeHtml } from './sanitize.js';

interface EditorState {
  list: NoteSummary[];
  search: string;
  current: NoteWithBlocks | null;
  saveTimers: Map<number, number>;
  loadingMermaid: Promise<MermaidLib> | null;
}

interface MermaidLib {
  render: (id: string, src: string) => Promise<{ svg: string }>;
}

const state: EditorState = {
  list: [],
  search: '',
  current: null,
  saveTimers: new Map(),
  loadingMermaid: null,
};

const SAVE_DEBOUNCE_MS = 600;

const COLOR_PALETTE = [
  '', // clear
  '#e6553a', '#f6b73c', '#3ac26a', '#2a6df4', '#7b3ff2',
  '#222222', '#888888',
];

const BLOCK_TYPE_OPTIONS: ReadonlyArray<{ type: NoteBlockType; label: string; icon: string }> = [
  { type: 'text', label: 'テキスト', icon: '¶' },
  { type: 'heading_1', label: '見出し 1', icon: 'H1' },
  { type: 'heading_2', label: '見出し 2', icon: 'H2' },
  { type: 'heading_3', label: '見出し 3', icon: 'H3' },
  { type: 'quote', label: '引用', icon: '"' },
  { type: 'bullet_list', label: 'リスト', icon: '•' },
  { type: 'numbered_list', label: '番号付きリスト', icon: '1.' },
  { type: 'todo', label: 'チェックリスト', icon: '☐' },
  { type: 'code', label: 'コード', icon: '</>' },
  { type: 'mermaid', label: 'Mermaid 図', icon: '⤵' },
  { type: 'table', label: 'テーブル', icon: '⊞' },
  { type: 'divider', label: '区切り', icon: '—' },
];

// ── Init ───────────────────────────────────────────────────────────────────

let initialized = false;

export function initNotes(): void {
  if (initialized) return;
  initialized = true;

  const search = byId<HTMLInputElement>('notesSearch');
  if (search) {
    search.addEventListener('input', () => {
      state.search = search.value;
      void refreshList();
    });
  }
  const newBtn = byId<HTMLButtonElement>('notesNewBtn');
  if (newBtn) newBtn.addEventListener('click', () => void createBlankNote());

  // Selection toolbar
  document.addEventListener('selectionchange', updateSelectionToolbar);
  document.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && !t.closest('.note-toolbar') && !t.closest('.note-block-content')) {
      hideSelectionToolbar();
    }
  });
}

export async function loadNotes(): Promise<void> {
  initNotes();
  await refreshList();
}

async function refreshList(): Promise<void> {
  const res = await api.listNotes(state.search);
  state.list = res.items;
  renderSidebar();
}

function renderSidebar(): void {
  const ul = byId<HTMLUListElement>('notesList');
  if (!ul) return;
  if (state.list.length === 0) {
    ul.innerHTML = `<li class="notes-empty muted">ノートはまだありません</li>`;
    return;
  }
  ul.innerHTML = state.list.map((n) => {
    const active = state.current?.id === n.id ? ' active' : '';
    const tags = n.tags.length ? `<span class="notes-tags">${n.tags.map((t) => `#${escapeHtml(t)}`).join(' ')}</span>` : '';
    const kindBadge = n.kind === 'chat' ? `<span class="notes-kind notes-kind-chat">💬 chat</span>` : '';
    return `
      <li class="notes-item${active}" data-note-id="${n.id}">
        <div class="notes-item-title">${escapeHtml(n.title || '無題')}</div>
        <div class="notes-item-meta">${kindBadge}${tags}<span class="notes-item-date">${formatDate(n.updated_at)}</span></div>
        <div class="notes-item-preview">${escapeHtml((n.preview || '').slice(0, 80))}</div>
      </li>
    `;
  }).join('');
  ul.querySelectorAll<HTMLLIElement>('.notes-item').forEach((li) => {
    li.addEventListener('click', () => {
      const id = Number(li.dataset.noteId);
      if (Number.isFinite(id)) void openNote(id);
    });
  });
}

function formatDate(s: string): string {
  if (!s) return '';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

// ── Note CRUD ──────────────────────────────────────────────────────────────

async function createBlankNote(): Promise<void> {
  const note = await api.createNote({
    title: '',
    initial_blocks: [{ block_type: 'text', text: '' }],
  });
  await openNote(note.id);
  await refreshList();
}

export async function openNote(id: number): Promise<void> {
  const note = await api.getNote(id);
  state.current = note;
  renderEditor();
  renderSidebar();
}

function renderEditor(): void {
  const pane = byId<HTMLElement>('noteEditor');
  if (!pane) return;
  if (!state.current) {
    pane.innerHTML = `<div class="notes-empty muted">左のリストから選択するか「+ 新規ノート」 で作成してください</div>`;
    return;
  }
  const note = state.current;
  pane.innerHTML = `
    <div class="note-header">
      <input class="note-title" id="noteTitle" value="${escapeHtml(note.title)}" placeholder="無題のノート" />
      <div class="note-header-meta">
        <input class="note-tags" id="noteTags" value="${escapeHtml(note.tags.join(', '))}" placeholder="タグ (カンマ区切り)" />
        <span class="muted" style="font-size:11px">${formatDate(note.updated_at)}</span>
        <button id="noteDeleteBtn" class="ghost danger" title="削除">🗑 削除</button>
      </div>
    </div>
    <div class="note-blocks" id="noteBlocks"></div>
    <div class="note-add-block">
      <button class="ghost" id="noteAddBlockBtn">+ ブロックを追加</button>
    </div>
  `;
  const titleInp = byId<HTMLInputElement>('noteTitle');
  if (titleInp) {
    titleInp.addEventListener('blur', () => {
      const v = titleInp.value.slice(0, 200);
      void api.patchNote(note.id, { title: v }).then(() => {
        note.title = v;
        renderSidebar();
      });
    });
  }
  const tagsInp = byId<HTMLInputElement>('noteTags');
  if (tagsInp) {
    tagsInp.addEventListener('blur', () => {
      const tags = tagsInp.value.split(',').map((s) => s.trim()).filter(Boolean);
      void api.patchNote(note.id, { tags }).then(() => {
        note.tags = tags;
        renderSidebar();
      });
    });
  }
  const delBtn = byId<HTMLButtonElement>('noteDeleteBtn');
  if (delBtn) delBtn.addEventListener('click', () => void confirmDelete());
  const addBtn = byId<HTMLButtonElement>('noteAddBlockBtn');
  if (addBtn) addBtn.addEventListener('click', () => void appendBlock('text'));
  renderAllBlocks();
}

async function confirmDelete(): Promise<void> {
  if (!state.current) return;
  if (!confirm('このノートを削除しますか?')) return;
  const id = state.current.id;
  await api.deleteNote(id);
  state.current = null;
  await refreshList();
  renderEditor();
}

// ── Block rendering ────────────────────────────────────────────────────────

function renderAllBlocks(): void {
  const container = byId<HTMLDivElement>('noteBlocks');
  if (!container || !state.current) return;
  container.innerHTML = '';
  for (const b of state.current.blocks) {
    container.appendChild(buildBlockElement(b));
  }
}

function buildBlockElement(block: NoteBlockRow): HTMLElement {
  const el = document.createElement('div');
  el.className = `note-block nb-${block.block_type}`;
  el.dataset.blockId = String(block.id);
  el.dataset.blockType = block.block_type;
  el.innerHTML = `
    <div class="nb-side">
      <button class="nb-handle" title="ブロック操作" data-action="menu">⋮</button>
    </div>
    <div class="nb-body"></div>
  `;
  const body = el.querySelector<HTMLElement>('.nb-body')!;
  body.appendChild(buildBlockBody(block));
  el.querySelector<HTMLButtonElement>('.nb-handle')!
    .addEventListener('click', (ev) => {
      ev.stopPropagation();
      openBlockMenu(block.id, ev.currentTarget as HTMLElement);
    });
  return el;
}

function buildBlockBody(block: NoteBlockRow): HTMLElement {
  switch (block.block_type) {
    case 'text':
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'quote':
      return buildContentEditable(block);
    case 'bullet_list':
    case 'numbered_list':
      return buildListBlock(block);
    case 'todo':
      return buildTodoBlock(block);
    case 'code':
      return buildCodeBlock(block);
    case 'mermaid':
      return buildMermaidBlock(block);
    case 'table':
      return buildTableBlock(block);
    case 'divider':
      return buildDividerBlock(block);
    default:
      return buildContentEditable(block);
  }
}

function tagForBlock(block: NoteBlockRow): string {
  switch (block.block_type) {
    case 'heading_1': return 'h1';
    case 'heading_2': return 'h2';
    case 'heading_3': return 'h3';
    case 'quote': return 'blockquote';
    default: return 'div';
  }
}

function buildContentEditable(block: NoteBlockRow): HTMLElement {
  const tag = tagForBlock(block);
  const el = document.createElement(tag);
  el.className = 'note-block-content';
  el.contentEditable = 'true';
  el.dataset.placeholder = placeholderFor(block.block_type);
  el.innerHTML = renderInline(block.text);
  attachAutoSave(el, block);
  return el;
}

function placeholderFor(t: NoteBlockType): string {
  switch (t) {
    case 'heading_1': return '見出し 1';
    case 'heading_2': return '見出し 2';
    case 'heading_3': return '見出し 3';
    case 'quote': return '引用…';
    default: return 'テキストを入力 (/ でブロック切替)';
  }
}

function buildListBlock(block: NoteBlockRow): HTMLElement {
  const data = parseData(block);
  const indent = Math.max(0, Math.min(6, data.indent ?? 0));
  const tag = block.block_type === 'numbered_list' ? 'ol' : 'ul';
  const list = document.createElement(tag);
  list.className = 'note-block-list';
  list.style.marginLeft = `${indent * 16}px`;
  const li = document.createElement('li');
  li.contentEditable = 'true';
  li.className = 'note-block-content';
  li.innerHTML = renderInline(block.text);
  list.appendChild(li);
  attachAutoSave(li, block);
  return list;
}

function buildTodoBlock(block: NoteBlockRow): HTMLElement {
  const data = parseData(block);
  const wrap = document.createElement('div');
  wrap.className = 'note-todo';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!data.checked;
  cb.addEventListener('change', () => {
    void saveBlockData(block, { checked: cb.checked });
  });
  const span = document.createElement('div');
  span.className = 'note-block-content';
  span.contentEditable = 'true';
  span.innerHTML = renderInline(block.text);
  attachAutoSave(span, block);
  wrap.append(cb, span);
  return wrap;
}

function buildCodeBlock(block: NoteBlockRow): HTMLElement {
  const data = parseData(block);
  const wrap = document.createElement('div');
  wrap.className = 'note-code-wrap';
  const langInp = document.createElement('input');
  langInp.type = 'text';
  langInp.className = 'note-code-lang';
  langInp.value = data.lang ?? '';
  langInp.placeholder = 'lang (e.g. ts)';
  langInp.addEventListener('change', () => {
    void saveBlockData(block, { lang: langInp.value.trim() });
  });
  const pre = document.createElement('pre');
  pre.className = 'note-block-content note-code';
  pre.contentEditable = 'true';
  pre.spellcheck = false;
  pre.textContent = block.text;
  attachAutoSave(pre, block, { plainText: true });
  wrap.append(langInp, pre);
  return wrap;
}

function buildMermaidBlock(block: NoteBlockRow): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'note-mermaid-wrap';
  const editor = document.createElement('pre');
  editor.className = 'note-block-content note-mermaid-src';
  editor.contentEditable = 'true';
  editor.spellcheck = false;
  editor.textContent = block.text || 'graph TD\n  A --> B';
  const preview = document.createElement('div');
  preview.className = 'note-mermaid-preview';
  preview.innerHTML = '<div class="muted">プレビュー読み込み中…</div>';
  let renderTimer = 0;
  const renderPreview = (): void => {
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => {
      void renderMermaid(editor.textContent || '', preview);
    }, 400);
  };
  attachAutoSave(editor, block, { plainText: true, onSave: () => renderPreview() });
  wrap.append(editor, preview);
  // 初回プレビュー
  void renderMermaid(editor.textContent || '', preview);
  return wrap;
}

const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

async function loadMermaid(): Promise<MermaidLib> {
  if (state.loadingMermaid) return state.loadingMermaid;
  state.loadingMermaid = (async () => {
    // 動的 ESM import — TS は string literal でない URL を import できないので
    // Function コンストラクタ越しに動的インポートする (esbuild は解決しない)。
    const dyn = new Function('u', 'return import(u)') as (u: string) => Promise<{ default: { initialize: (o: unknown) => void; render: (id: string, src: string) => Promise<{ svg: string }> } }>;
    const mod = await dyn(MERMAID_URL);
    mod.default.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
    return mod.default;
  })();
  return state.loadingMermaid;
}

let mermaidIdSeq = 0;
async function renderMermaid(src: string, target: HTMLElement): Promise<void> {
  try {
    const m = await loadMermaid();
    const id = `m${++mermaidIdSeq}`;
    const out = await m.render(id, src);
    target.innerHTML = out.svg;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    target.innerHTML = `<div class="note-error">Mermaid: ${escapeHtml(msg)}</div>`;
  }
}

function buildTableBlock(block: NoteBlockRow): HTMLElement {
  const data = parseData(block);
  const rows = (data.rows && data.rows.length) ? data.rows : [['', ''], ['', '']];
  const header = data.header ?? true;
  const wrap = document.createElement('div');
  wrap.className = 'note-table-wrap';
  const table = document.createElement('table');
  table.className = 'note-table';
  const renderTable = (): void => {
    table.innerHTML = '';
    rows.forEach((row, ri) => {
      const tr = document.createElement('tr');
      row.forEach((cell, ci) => {
        const cellTag = (header && ri === 0) ? 'th' : 'td';
        const td = document.createElement(cellTag);
        td.contentEditable = 'true';
        td.innerHTML = renderInline(cell);
        td.addEventListener('blur', () => {
          rows[ri][ci] = htmlToStorageText(td);
          void saveBlockData(block, { rows, header });
        });
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
  };
  renderTable();

  const ctrls = document.createElement('div');
  ctrls.className = 'note-table-ctrls';
  ctrls.innerHTML = `
    <button class="ghost" data-act="add-row">+ 行</button>
    <button class="ghost" data-act="add-col">+ 列</button>
    <button class="ghost" data-act="del-row">− 行</button>
    <button class="ghost" data-act="del-col">− 列</button>
    <label><input type="checkbox" class="note-table-header" ${header ? 'checked' : ''}/> ヘッダ行</label>
  `;
  ctrls.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'add-row') rows.push(new Array(rows[0]?.length || 1).fill(''));
      if (act === 'add-col') rows.forEach((r) => r.push(''));
      if (act === 'del-row' && rows.length > 1) rows.pop();
      if (act === 'del-col' && (rows[0]?.length || 0) > 1) rows.forEach((r) => r.pop());
      renderTable();
      void saveBlockData(block, { rows, header });
    });
  });
  ctrls.querySelector<HTMLInputElement>('.note-table-header')!.addEventListener('change', (ev) => {
    const h = (ev.currentTarget as HTMLInputElement).checked;
    renderTable();
    void saveBlockData(block, { rows, header: h });
  });
  wrap.append(table, ctrls);
  return wrap;
}

function buildDividerBlock(_block: NoteBlockRow): HTMLElement {
  const hr = document.createElement('hr');
  hr.className = 'note-divider';
  return hr;
}

function parseData(block: NoteBlockRow): BlockData {
  if (!block.data_json) return {};
  try { return JSON.parse(block.data_json) as BlockData; } catch { return {}; }
}

// ── Auto-save ──────────────────────────────────────────────────────────────

function attachAutoSave(
  el: HTMLElement,
  block: NoteBlockRow,
  opts: { plainText?: boolean; onSave?: () => void } = {},
): void {
  const flush = (): void => {
    const text = opts.plainText ? (el.textContent ?? '') : htmlToStorageText(el);
    if (text === block.text) { opts.onSave?.(); return; }
    block.text = text;
    void api.patchBlock(block.note_id, block.id, { text }).then(() => {
      opts.onSave?.();
    });
  };
  el.addEventListener('blur', flush);
  el.addEventListener('input', () => {
    if (state.saveTimers.has(block.id)) window.clearTimeout(state.saveTimers.get(block.id));
    state.saveTimers.set(block.id, window.setTimeout(flush, SAVE_DEBOUNCE_MS));
  });
  el.addEventListener('keydown', (ev) => handleEditorKey(ev, block));
}

function htmlToStorageText(el: HTMLElement): string {
  // sanitize → return innerHTML (fragment safe)
  const sanitized = sanitizeInlineHtml(el.innerHTML);
  return sanitized;
}

async function saveBlockData(block: NoteBlockRow, data: BlockData): Promise<void> {
  block.data_json = JSON.stringify(data);
  await api.patchBlock(block.note_id, block.id, { data });
}

// ── Editor key handling (Enter / Backspace / slash menu) ──────────────────

function handleEditorKey(ev: KeyboardEvent, block: NoteBlockRow): void {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    if (block.block_type === 'code' || block.block_type === 'mermaid') return; // allow newlines
    ev.preventDefault();
    void appendBlock('text', block.id);
    return;
  }
  if (ev.key === 'Backspace') {
    const target = ev.currentTarget as HTMLElement;
    if (target.textContent === '' && state.current && state.current.blocks.length > 1) {
      ev.preventDefault();
      void removeBlock(block.id);
    }
    return;
  }
  if (ev.key === '/' && (ev.currentTarget as HTMLElement).textContent === '') {
    ev.preventDefault();
    openBlockMenu(block.id, ev.currentTarget as HTMLElement, true);
    return;
  }
}

async function appendBlock(type: NoteBlockType, afterBlockId?: number): Promise<void> {
  if (!state.current) return;
  const newBlock = await api.createBlock(state.current.id, {
    block_type: type,
    after_block_id: afterBlockId ?? null,
  });
  // refresh blocks
  state.current = await api.getNote(state.current.id);
  renderAllBlocks();
  // focus new block's editable
  const el = document.querySelector<HTMLElement>(`[data-block-id="${newBlock.id}"] .note-block-content`);
  if (el) el.focus();
}

async function removeBlock(blockId: number): Promise<void> {
  if (!state.current) return;
  await api.deleteBlock(state.current.id, blockId);
  state.current = await api.getNote(state.current.id);
  renderAllBlocks();
}

async function changeBlockType(blockId: number, newType: NoteBlockType): Promise<void> {
  if (!state.current) return;
  await api.patchBlock(state.current.id, blockId, { block_type: newType });
  state.current = await api.getNote(state.current.id);
  renderAllBlocks();
}

// ── Block menu (slash menu / handle click) ────────────────────────────────

let openMenu: HTMLElement | null = null;

function openBlockMenu(blockId: number, anchor: HTMLElement, _slashMode = false): void {
  closeBlockMenu();
  const menu = document.createElement('div');
  menu.className = 'note-block-menu';
  menu.innerHTML = `
    <div class="nbm-section">ブロック種別</div>
    ${BLOCK_TYPE_OPTIONS.map((o) => `
      <button class="nbm-item" data-type="${o.type}"><span class="nbm-icon">${o.icon}</span>${o.label}</button>
    `).join('')}
    <div class="nbm-section">操作</div>
    <button class="nbm-item nbm-danger" data-action="delete">🗑 削除</button>
  `;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.bottom + 4}px`;
  openMenu = menu;
  menu.querySelectorAll<HTMLButtonElement>('.nbm-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.type as NoteBlockType | undefined;
      const a = btn.dataset.action;
      closeBlockMenu();
      if (t) void changeBlockType(blockId, t);
      else if (a === 'delete') void removeBlock(blockId);
    });
  });
  setTimeout(() => {
    document.addEventListener('click', closeOnOutside, { once: true });
  }, 0);
}

function closeOnOutside(e: MouseEvent): void {
  if (openMenu && !openMenu.contains(e.target as Node)) closeBlockMenu();
}

function closeBlockMenu(): void {
  if (openMenu) { openMenu.remove(); openMenu = null; }
}

// ── Selection toolbar (B / I / 🎨色 / link) ────────────────────────────────

let toolbar: HTMLElement | null = null;

function ensureToolbar(): HTMLElement {
  if (toolbar) return toolbar;
  toolbar = document.createElement('div');
  toolbar.className = 'note-toolbar';
  toolbar.innerHTML = `
    <button data-cmd="bold" title="太字"><b>B</b></button>
    <button data-cmd="italic" title="斜体"><i>I</i></button>
    <button data-cmd="code" title="インラインコード">${'<'}/${'>'}</button>
    <button data-cmd="link" title="リンク">🔗</button>
    <button data-cmd="color" title="色">🎨</button>
  `;
  toolbar.style.display = 'none';
  document.body.appendChild(toolbar);
  toolbar.querySelectorAll<HTMLButtonElement>('button[data-cmd]').forEach((b) => {
    b.addEventListener('mousedown', (ev) => ev.preventDefault());
    b.addEventListener('click', () => applyToolbarCmd(b.dataset.cmd ?? ''));
  });
  return toolbar;
}

function updateSelectionToolbar(): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    hideSelectionToolbar();
    return;
  }
  const range = sel.getRangeAt(0);
  let parent: Node | null = range.commonAncestorContainer;
  while (parent && parent.nodeType !== Node.ELEMENT_NODE) parent = parent.parentNode;
  if (!parent || !(parent as Element).closest('.note-block-content')) {
    hideSelectionToolbar();
    return;
  }
  const tb = ensureToolbar();
  const r = range.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    hideSelectionToolbar();
    return;
  }
  tb.style.display = 'flex';
  tb.style.left = `${Math.max(8, r.left + window.scrollX)}px`;
  tb.style.top = `${Math.max(8, r.top + window.scrollY - 40)}px`;
}

function hideSelectionToolbar(): void {
  if (toolbar) toolbar.style.display = 'none';
}

function applyToolbarCmd(cmd: string): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (cmd === 'color') return showColorPicker(range);
  if (cmd === 'link') {
    const url = prompt('リンク URL を入力してください:');
    if (url && /^(https?:|mailto:|\/|#)/i.test(url)) {
      wrapRangeWith(range, (sel) => {
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = sel;
        return a;
      });
    }
    return;
  }
  if (cmd === 'bold') wrapRangeWith(range, (s) => Object.assign(document.createElement('b'), { textContent: s }));
  if (cmd === 'italic') wrapRangeWith(range, (s) => Object.assign(document.createElement('i'), { textContent: s }));
  if (cmd === 'code') wrapRangeWith(range, (s) => Object.assign(document.createElement('code'), { textContent: s }));
  hideSelectionToolbar();
  triggerSaveForSelection(range);
}

function wrapRangeWith(range: Range, makeNode: (text: string) => HTMLElement): void {
  const text = range.toString();
  if (!text) return;
  const node = makeNode(text);
  range.deleteContents();
  range.insertNode(node);
  // place caret after
  const r2 = document.createRange();
  r2.setStartAfter(node);
  r2.collapse(true);
  const sel = window.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(r2); }
}

function showColorPicker(range: Range): void {
  closeBlockMenu();
  const popup = document.createElement('div');
  popup.className = 'note-color-popup';
  popup.innerHTML = `
    <div class="ncp-row">${COLOR_PALETTE.map((c) => `
      <button class="ncp-swatch" data-color="${c}" style="${c ? `background:${c}` : ''}" title="${c || '色クリア'}">${c ? '' : '×'}</button>
    `).join('')}</div>
    <div class="ncp-custom">
      <input type="color" id="ncpCustom" />
      <button class="ghost" id="ncpApply">適用</button>
    </div>
  `;
  document.body.appendChild(popup);
  const r = range.getBoundingClientRect();
  popup.style.left = `${r.left + window.scrollX}px`;
  popup.style.top = `${r.bottom + window.scrollY + 4}px`;
  popup.querySelectorAll<HTMLButtonElement>('.ncp-swatch').forEach((b) => {
    b.addEventListener('click', () => {
      const c = b.dataset.color || '';
      applyColor(range, c);
      popup.remove();
      hideSelectionToolbar();
    });
  });
  popup.querySelector<HTMLButtonElement>('#ncpApply')!.addEventListener('click', () => {
    const v = popup.querySelector<HTMLInputElement>('#ncpCustom')!.value;
    applyColor(range, v);
    popup.remove();
    hideSelectionToolbar();
  });
  setTimeout(() => {
    document.addEventListener('click', function once(e) {
      if (!popup.contains(e.target as Node)) popup.remove();
      else document.addEventListener('click', once, { once: true });
    }, { once: true });
  }, 0);
}

function applyColor(range: Range, color: string): void {
  if (!color) {
    // unwrap span style
    const text = range.toString();
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
  } else {
    wrapRangeWith(range, (s) => {
      const span = document.createElement('span');
      span.style.color = color;
      span.textContent = s;
      return span;
    });
  }
  triggerSaveForSelection(range);
}

function triggerSaveForSelection(range: Range): void {
  let parent: Node | null = range.commonAncestorContainer;
  while (parent && parent.nodeType !== Node.ELEMENT_NODE) parent = parent.parentNode;
  if (!parent) return;
  const blockEl = (parent as Element).closest('.note-block') as HTMLElement | null;
  if (!blockEl?.dataset.blockId) return;
  const id = Number(blockEl.dataset.blockId);
  const editable = blockEl.querySelector<HTMLElement>('.note-block-content');
  if (!editable || !state.current) return;
  const block = state.current.blocks.find((b) => b.id === id);
  if (!block) return;
  const text = htmlToStorageText(editable);
  block.text = text;
  void api.patchBlock(state.current.id, id, { text });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// 拡張から呼ぶ用 — 外部チャットを Note に取り込んだ後にエディタを開く。
export async function openNoteByIdIfPresent(noteId: number): Promise<void> {
  if (!Number.isFinite(noteId)) return;
  await openNote(noteId);
}
