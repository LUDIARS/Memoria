// Note エディタ (rev2) — UUID + bookmark base + per-user comment sets。
//
// DOM 構造 (notesView 内):
//   .notes-layout
//     .notes-sidebar       ← ノート一覧 + 検索 + 新規 (空 / from-bookmark)
//     .notes-pane          ← タイトル + bookmark banner + ブロック群
//     .notes-comments      ← コメントパネル (右サイド)
//
// 各ブロックは contenteditable で blur で auto-save。 / で slash menu。

import * as api from './api.js';
import type {
  NoteBlockRow, NoteBlockType, NoteSummary, NoteWithBlocks, BlockData,
  CommentSetWithComments, CommentRow, BookmarkSummary,
} from './types.js';
import { renderInline } from './markdown.js';
import { sanitizeInlineHtml, escapeHtml } from './sanitize.js';

interface MermaidLib {
  initialize: (o: unknown) => void;
  render: (id: string, src: string) => Promise<{ svg: string }>;
}

interface EditorState {
  list: NoteSummary[];
  search: string;
  current: NoteWithBlocks | null;
  currentSet: { id: string; comments: CommentRow[] } | null;
  saveTimers: Map<string, number>;
  loadingMermaid: Promise<MermaidLib> | null;
  bookmarkPickerOpen: boolean;
}

const state: EditorState = {
  list: [],
  search: '',
  current: null,
  currentSet: null,
  saveTimers: new Map(),
  loadingMermaid: null,
  bookmarkPickerOpen: false,
};

const SAVE_DEBOUNCE_MS = 600;

const COLOR_PALETTE = [
  '', '#e6553a', '#f6b73c', '#3ac26a', '#2a6df4', '#7b3ff2',
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

  const fromBookmarkBtn = byId<HTMLButtonElement>('notesFromBookmarkBtn');
  if (fromBookmarkBtn) fromBookmarkBtn.addEventListener('click', () => openBookmarkPicker());

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
    const kindBadge = n.kind === 'chat' ? `<span class="notes-kind notes-kind-chat">💬 chat</span>`
                  : n.kind === 'bookmark' ? `<span class="notes-kind notes-kind-bm">🔖 bookmark</span>` : '';
    return `
      <li class="notes-item${active}" data-note-id="${escapeHtml(n.id)}">
        <div class="notes-item-title">${escapeHtml(n.title || '無題')}</div>
        <div class="notes-item-meta">${kindBadge}${tags}<span class="notes-item-date">${formatDate(n.updated_at)}</span></div>
        <div class="notes-item-preview">${escapeHtml((n.preview || '').slice(0, 80))}</div>
      </li>
    `;
  }).join('');
  ul.querySelectorAll<HTMLLIElement>('.notes-item').forEach((li) => {
    li.addEventListener('click', () => {
      const id = li.dataset.noteId || '';
      if (id) void openNote(id);
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

export async function openNote(uuid: string): Promise<void> {
  const note = await api.getNote(uuid);
  state.current = note;
  state.currentSet = null;
  renderEditor();
  renderSidebar();
  void loadOwnCommentSet();
}

function renderEditor(): void {
  const pane = byId<HTMLElement>('noteEditor');
  if (!pane) return;
  if (!state.current) {
    pane.innerHTML = `<div class="notes-empty muted">左のリストから選択するか「+ 新規ノート」 で作成してください</div>`;
    return;
  }
  const note = state.current;
  const isBookmark = note.kind === 'bookmark' && !!note.bookmark_id;
  const bookmarkBanner = isBookmark
    ? `<div class="note-bookmark-banner">
         <span class="bm-icon">🔖</span>
         <a href="${escapeHtml(note.bookmark_url ?? '#')}" target="_blank" rel="noopener noreferrer" class="bm-link">${escapeHtml(note.bookmark_url ?? '')}</a>
         <button class="ghost bm-unlink" id="bmUnlinkBtn" title="bookmark を解除して通常ノートに戻す">解除</button>
       </div>`
    : '';
  const body = isBookmark
    ? `<div class="note-canvas-toolbar">
         <button id="addFloatingBtn" class="ghost">📍 フローティングコメント追加</button>
         <span class="muted" style="font-size:11px">canvas をクリック → 注釈を挿入 / ドラッグで移動</span>
       </div>
       <div class="note-canvas-wrap" id="noteCanvasWrap">
         <iframe id="noteCanvasFrame" sandbox="allow-same-origin allow-popups" title="bookmark snapshot"></iframe>
         <div class="note-canvas-overlay" id="noteCanvasOverlay"></div>
       </div>`
    : `<div class="note-blocks" id="noteBlocks"></div>
       <div class="note-add-block">
         <button class="ghost" id="noteAddBlockBtn">+ ブロックを追加</button>
       </div>`;
  pane.innerHTML = `
    <div class="note-header">
      <input class="note-title" id="noteTitle" value="${escapeHtml(note.title)}" placeholder="無題のノート" />
      <div class="note-header-meta">
        <input class="note-tags" id="noteTags" value="${escapeHtml(note.tags.join(', '))}" placeholder="タグ (カンマ区切り)" />
        <span class="muted" style="font-size:11px">${formatDate(note.updated_at)}</span>
        <button id="noteDeleteBtn" class="ghost danger" title="削除">🗑 削除</button>
      </div>
    </div>
    ${bookmarkBanner}
    ${body}
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
  const bmUnlink = byId<HTMLButtonElement>('bmUnlinkBtn');
  if (bmUnlink) bmUnlink.addEventListener('click', () => void unlinkBookmark());
  if (isBookmark) {
    initBookmarkCanvas(note.id);
    const addFloatBtn = byId<HTMLButtonElement>('addFloatingBtn');
    if (addFloatBtn) addFloatBtn.addEventListener('click', () => void insertFloatingBlock());
  } else {
    const addBtn = byId<HTMLButtonElement>('noteAddBlockBtn');
    if (addBtn) addBtn.addEventListener('click', () => void appendBlock('text'));
    renderAllBlocks();
  }
}

async function unlinkBookmark(): Promise<void> {
  if (!state.current) return;
  if (!confirm('このノートから bookmark を切り離して通常ノートに戻しますか? (canvas + floating コメントは取り除かれます)')) return;
  await api.patchNote(state.current.id, { bookmark_id: null });
  state.current = await api.getNote(state.current.id);
  renderEditor();
}

async function confirmDelete(): Promise<void> {
  if (!state.current) return;
  if (!confirm('このノートを削除しますか?')) return;
  const id = state.current.id;
  await api.deleteNote(id);
  state.current = null;
  state.currentSet = null;
  await refreshList();
  renderEditor();
  renderCommentPanel();
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
  el.dataset.blockUuid = block.uuid;
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
      openBlockMenu(block.uuid, ev.currentTarget as HTMLElement);
    });
  return el;
}

function buildBlockBody(block: NoteBlockRow): HTMLElement {
  switch (block.block_type) {
    case 'text': case 'heading_1': case 'heading_2': case 'heading_3': case 'quote':
      return buildContentEditable(block);
    case 'bullet_list': case 'numbered_list':
      return buildListBlock(block);
    case 'todo':       return buildTodoBlock(block);
    case 'code':       return buildCodeBlock(block);
    case 'mermaid':    return buildMermaidBlock(block);
    case 'table':      return buildTableBlock(block);
    case 'divider':    return buildDividerBlock(block);
    case 'floating_text': {
      // 通常ブロック流に floating が混入している (本来 bookmark note の overlay でレンダリング)。
      // フォールバック: 内容を一行で表示し「これは floating です」 と注記。
      const div = document.createElement('div');
      div.className = 'note-block-content muted';
      div.textContent = `📍 floating block (bookmark note でのみ表示): ${block.text.slice(0, 40)}`;
      return div;
    }
    default:           return buildContentEditable(block);
  }
}

function tagForBlock(block: NoteBlockRow): string {
  switch (block.block_type) {
    case 'heading_1': return 'h1';
    case 'heading_2': return 'h2';
    case 'heading_3': return 'h3';
    case 'quote':     return 'blockquote';
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
    case 'quote':     return '引用…';
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
  void renderMermaid(editor.textContent || '', preview);
  return wrap;
}

const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

async function loadMermaid(): Promise<MermaidLib> {
  if (state.loadingMermaid) return state.loadingMermaid;
  state.loadingMermaid = (async () => {
    const dyn = new Function('u', 'return import(u)') as (u: string) => Promise<{ default: MermaidLib }>;
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
    void api.patchBlock(block.note_id, block.uuid, { text }).then(() => {
      opts.onSave?.();
    });
  };
  el.addEventListener('blur', flush);
  el.addEventListener('input', () => {
    if (state.saveTimers.has(block.uuid)) window.clearTimeout(state.saveTimers.get(block.uuid));
    state.saveTimers.set(block.uuid, window.setTimeout(flush, SAVE_DEBOUNCE_MS));
  });
  el.addEventListener('keydown', (ev) => handleEditorKey(ev, block));
}

function htmlToStorageText(el: HTMLElement): string {
  return sanitizeInlineHtml(el.innerHTML);
}

async function saveBlockData(block: NoteBlockRow, data: BlockData): Promise<void> {
  block.data_json = JSON.stringify(data);
  await api.patchBlock(block.note_id, block.uuid, { data });
}

// ── Editor key handling ──────────────────────────────────────────────────

function handleEditorKey(ev: KeyboardEvent, block: NoteBlockRow): void {
  // floating / code / mermaid は Enter で新ブロックを作らない (本文に改行を許す)
  const skipEnter = block.block_type === 'code' || block.block_type === 'mermaid' || block.block_type === 'floating_text';
  if (ev.key === 'Enter' && !ev.shiftKey && !skipEnter) {
    ev.preventDefault();
    void appendBlock('text', block.uuid);
    return;
  }
  if (ev.key === 'Backspace' && block.block_type !== 'floating_text') {
    const target = ev.currentTarget as HTMLElement;
    if (target.textContent === '' && state.current && state.current.blocks.length > 1) {
      ev.preventDefault();
      void removeBlock(block.uuid);
    }
    return;
  }
  if (ev.key === '/' && block.block_type !== 'floating_text' && (ev.currentTarget as HTMLElement).textContent === '') {
    ev.preventDefault();
    openBlockMenu(block.uuid, ev.currentTarget as HTMLElement, true);
    return;
  }
}

async function appendBlock(type: NoteBlockType, afterBlockUuid?: string): Promise<void> {
  if (!state.current) return;
  const newBlock = await api.createBlock(state.current.id, {
    block_type: type,
    after_block_uuid: afterBlockUuid ?? null,
  });
  state.current = await api.getNote(state.current.id);
  renderAllBlocks();
  const el = document.querySelector<HTMLElement>(`[data-block-uuid="${newBlock.uuid}"] .note-block-content`);
  if (el) el.focus();
}

async function removeBlock(blockUuid: string): Promise<void> {
  if (!state.current) return;
  await api.deleteBlock(state.current.id, blockUuid);
  state.current = await api.getNote(state.current.id);
  renderAllBlocks();
}

async function changeBlockType(blockUuid: string, newType: NoteBlockType): Promise<void> {
  if (!state.current) return;
  await api.patchBlock(state.current.id, blockUuid, { block_type: newType });
  state.current = await api.getNote(state.current.id);
  renderAllBlocks();
}

// ── Block menu (slash menu / handle click) ────────────────────────────────

let openMenu: HTMLElement | null = null;

function openBlockMenu(blockUuid: string, anchor: HTMLElement, _slashMode = false): void {
  closeBlockMenu();
  const menu = document.createElement('div');
  menu.className = 'note-block-menu';
  // 通常ノートのブロックメニューでは floating_text を除外 (= bookmark canvas 専用)
  const typeOptions = BLOCK_TYPE_OPTIONS.filter((o) => o.type !== 'floating_text');
  menu.innerHTML = `
    <div class="nbm-section">ブロック種別</div>
    ${typeOptions.map((o) => `
      <button class="nbm-item" data-type="${o.type}"><span class="nbm-icon">${o.icon}</span>${o.label}</button>
    `).join('')}
    <div class="nbm-section">操作</div>
    <button class="nbm-item nbm-action" data-action="comment">💬 このブロックにコメント</button>
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
      if (t) void changeBlockType(blockUuid, t);
      else if (a === 'delete') void removeBlock(blockUuid);
      else if (a === 'comment') void quickComment(blockUuid);
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
      wrapRangeWith(range, (s) => {
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = s;
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
  if (!blockEl?.dataset.blockUuid) return;
  const blockUuid = blockEl.dataset.blockUuid;
  const editable = blockEl.querySelector<HTMLElement>('.note-block-content');
  if (!editable || !state.current) return;
  const block = state.current.blocks.find((b) => b.uuid === blockUuid);
  if (!block) return;
  const text = htmlToStorageText(editable);
  block.text = text;
  void api.patchBlock(state.current.id, blockUuid, { text });
}

// ── Bookmark picker (新規 bookmark note 作成のみ) ────────────────────────
//
// 通常ノートに後から bookmark を紐付ける機能はない (spec: 通常ノートに
// bookmark を挟まない方針)。 このピッカーは常に「+ 新規 bookmark note」 を作る。

function openBookmarkPicker(): void {
  if (state.bookmarkPickerOpen) return;
  state.bookmarkPickerOpen = true;
  const overlay = document.createElement('div');
  overlay.className = 'note-bm-picker-overlay';
  overlay.innerHTML = `
    <div class="note-bm-picker">
      <div class="note-bm-picker-head">
        <h3>bookmark をベースにノート作成</h3>
        <button class="modal-close" id="bmpClose">×</button>
      </div>
      <input type="search" id="bmpSearch" placeholder="タイトル / URL で検索" />
      <ul id="bmpList" class="note-bm-list"></ul>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = (): void => {
    overlay.remove();
    state.bookmarkPickerOpen = false;
  };
  overlay.querySelector<HTMLButtonElement>('#bmpClose')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const search = overlay.querySelector<HTMLInputElement>('#bmpSearch')!;
  const listEl = overlay.querySelector<HTMLUListElement>('#bmpList')!;
  let timer = 0;
  const refresh = async (): Promise<void> => {
    const items: BookmarkSummary[] = await api.searchBookmarks(search.value, 30);
    listEl.innerHTML = items.map((b) => `
      <li class="note-bm-row" data-id="${b.id}">
        <div class="note-bm-title">${escapeHtml(b.title || b.url)}</div>
        <div class="note-bm-url muted">${escapeHtml(b.url)}</div>
      </li>
    `).join('');
    listEl.querySelectorAll<HTMLLIElement>('.note-bm-row').forEach((li) => {
      li.addEventListener('click', () => {
        const bid = Number(li.dataset.id);
        if (!Number.isFinite(bid)) return;
        void api.createNote({ bookmark_id: bid }).then(async (n) => {
          close();
          await openNote(n.id);
          await refreshList();
        });
      });
    });
  };
  search.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(refresh, 200);
  });
  void refresh();
  search.focus();
}

// ── Bookmark canvas (iframe + floating overlay) ──────────────────────────

function initBookmarkCanvas(noteId: string): void {
  const wrap = byId<HTMLDivElement>('noteCanvasWrap');
  const frame = byId<HTMLIFrameElement>('noteCanvasFrame');
  const overlay = byId<HTMLDivElement>('noteCanvasOverlay');
  if (!wrap || !frame || !overlay) return;

  frame.src = `/api/notes/${encodeURIComponent(noteId)}/bookmark-html`;
  frame.addEventListener('load', () => {
    try {
      const doc = frame.contentDocument;
      if (doc) {
        const h = Math.max(doc.body?.scrollHeight ?? 800, 800);
        frame.style.height = `${h}px`;
        overlay.style.height = `${h}px`;
        overlay.style.width = `${frame.clientWidth}px`;
      }
    } catch { /* cross-origin or empty doc — fall back to default height */ }
    renderFloatingBlocks();
  });
}

function renderFloatingBlocks(): void {
  const overlay = byId<HTMLDivElement>('noteCanvasOverlay');
  if (!overlay || !state.current) return;
  overlay.innerHTML = '';
  const floats = state.current.blocks.filter((b) => b.block_type === 'floating_text');
  for (const fb of floats) {
    overlay.appendChild(buildFloatingElement(fb));
  }
}

function buildFloatingElement(block: NoteBlockRow): HTMLElement {
  const data = parseData(block);
  const el = document.createElement('div');
  el.className = 'note-floating';
  el.dataset.blockUuid = block.uuid;
  el.style.left = `${data.x ?? 40}px`;
  el.style.top = `${data.y ?? 40}px`;
  if (data.width) el.style.width = `${data.width}px`;
  if (data.color) el.style.borderColor = data.color;
  el.innerHTML = `
    <div class="nf-handle" title="ドラッグで移動">⋮⋮</div>
    <div class="note-block-content nf-body" contenteditable="true" data-placeholder="コメントを入力">${renderInline(block.text)}</div>
    <button class="nf-del" title="削除">×</button>
  `;
  const body = el.querySelector<HTMLElement>('.nf-body')!;
  attachAutoSave(body, block);
  el.querySelector<HTMLButtonElement>('.nf-del')!.addEventListener('click', (ev) => {
    ev.stopPropagation();
    void removeBlock(block.uuid).then(() => renderFloatingBlocks());
  });
  setupFloatingDrag(el, block);
  return el;
}

function setupFloatingDrag(el: HTMLElement, block: NoteBlockRow): void {
  const handle = el.querySelector<HTMLElement>('.nf-handle');
  if (!handle) return;
  let drag: { startX: number; startY: number; origX: number; origY: number; pointerId: number } | null = null;
  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    try { handle.setPointerCapture(e.pointerId); } catch {}
    const data = parseData(block);
    drag = {
      startX: e.clientX, startY: e.clientY,
      origX: data.x ?? (parseFloat(el.style.left) || 0),
      origY: data.y ?? (parseFloat(el.style.top) || 0),
      pointerId: e.pointerId,
    };
    el.classList.add('dragging');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const x = Math.max(0, drag.origX + dx);
    const y = Math.max(0, drag.origY + dy);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  });
  const finish = async (): Promise<void> => {
    if (!drag) return;
    try { handle.releasePointerCapture(drag.pointerId); } catch {}
    el.classList.remove('dragging');
    const x = parseFloat(el.style.left) || 0;
    const y = parseFloat(el.style.top) || 0;
    drag = null;
    const cur = parseData(block);
    if (cur.x === x && cur.y === y) return;
    await saveBlockData(block, { ...cur, x, y });
  };
  handle.addEventListener('pointerup', () => { void finish(); });
  handle.addEventListener('pointercancel', () => { void finish(); });
}

async function insertFloatingBlock(): Promise<void> {
  if (!state.current) return;
  // canvas の表示中央にデフォルト配置
  const wrap = byId<HTMLDivElement>('noteCanvasWrap');
  const overlay = byId<HTMLDivElement>('noteCanvasOverlay');
  let x = 60, y = 60;
  if (wrap && overlay) {
    x = Math.max(20, Math.round(wrap.clientWidth / 2 - 100));
    y = Math.max(20, wrap.scrollTop + 80);
  }
  await api.createBlock(state.current.id, {
    block_type: 'floating_text',
    text: '',
    data: { x, y, anchor: { kind: 'point' } },
  });
  state.current = await api.getNote(state.current.id);
  renderFloatingBlocks();
  // 新規 floating の本文に focus
  const last = state.current.blocks.filter((b) => b.block_type === 'floating_text').pop();
  if (last) {
    const fb = document.querySelector<HTMLElement>(`.note-floating[data-block-uuid="${last.uuid}"] .nf-body`);
    if (fb) fb.focus();
  }
}

// ── Comment panel ────────────────────────────────────────────────────────

async function loadOwnCommentSet(): Promise<void> {
  if (!state.current) return;
  const set = await api.getOrCreateCommentSet(state.current.id, null);
  const all = await api.listCommentSets(state.current.id, null);
  const ours = all.items.find((s) => s.id === set.id);
  state.currentSet = { id: set.id, comments: ours?.comments ?? [] };
  renderCommentPanel();
}

function renderCommentPanel(): void {
  const panel = byId<HTMLElement>('notesComments');
  if (!panel) return;
  if (!state.current || !state.currentSet) {
    panel.innerHTML = '<div class="muted">ノートを選択するとコメントが表示されます</div>';
    return;
  }
  const set = state.currentSet;
  panel.innerHTML = `
    <div class="nc-head">
      <h3>💬 コメント</h3>
      <span class="muted" style="font-size:11px">自分の set (UUID: ${set.id.slice(0, 8)}…)</span>
    </div>
    <ul class="nc-list" id="ncList"></ul>
    <div class="nc-add">
      <textarea id="ncInput" placeholder="コメント追加 (Ctrl+Enter で送信)"></textarea>
      <button id="ncAddBtn" class="primary">追加</button>
    </div>
  `;
  renderCommentList();
  const ta = byId<HTMLTextAreaElement>('ncInput');
  const addBtn = byId<HTMLButtonElement>('ncAddBtn');
  if (addBtn) addBtn.addEventListener('click', () => void submitComment());
  if (ta) {
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void submitComment();
      }
    });
  }
}

function renderCommentList(): void {
  const ul = byId<HTMLUListElement>('ncList');
  if (!ul || !state.currentSet) return;
  if (state.currentSet.comments.length === 0) {
    ul.innerHTML = '<li class="muted nc-empty">まだコメントはありません</li>';
    return;
  }
  ul.innerHTML = state.currentSet.comments.map((c) => `
    <li class="nc-item" data-id="${escapeHtml(c.id)}">
      <div class="nc-text">${renderInline(c.text)}</div>
      <div class="nc-meta">
        ${c.target_block_uuid ? `<span class="nc-anchor" title="block ${c.target_block_uuid.slice(0,8)}…">📌</span>` : ''}
        <span class="muted">${formatDate(c.updated_at)}</span>
        <button class="ghost nc-del" data-id="${escapeHtml(c.id)}" title="削除">×</button>
      </div>
    </li>
  `).join('');
  ul.querySelectorAll<HTMLButtonElement>('.nc-del').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.id || '';
      void deleteCommentLocal(id);
    });
  });
}

async function submitComment(): Promise<void> {
  if (!state.current || !state.currentSet) return;
  const ta = byId<HTMLTextAreaElement>('ncInput');
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) return;
  const c = await api.createComment(state.current.id, state.currentSet.id, { text });
  state.currentSet.comments.push(c);
  ta.value = '';
  renderCommentList();
}

async function deleteCommentLocal(commentId: string): Promise<void> {
  if (!state.current || !state.currentSet) return;
  await api.deleteComment(state.current.id, state.currentSet.id, commentId);
  state.currentSet.comments = state.currentSet.comments.filter((c) => c.id !== commentId);
  renderCommentList();
}

async function quickComment(blockUuid: string): Promise<void> {
  if (!state.current || !state.currentSet) return;
  const text = prompt('このブロックへのコメント:');
  if (!text?.trim()) return;
  const c = await api.createComment(state.current.id, state.currentSet.id, { text: text.trim(), target_block_uuid: blockUuid });
  state.currentSet.comments.push(c);
  renderCommentList();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export async function openNoteByIdIfPresent(noteId: string): Promise<void> {
  if (!noteId) return;
  await openNote(noteId);
}
