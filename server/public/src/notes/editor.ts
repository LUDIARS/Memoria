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
  CommentRow, BookmarkSummary,
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
  /** 最後に focus された block の uuid。 モバイル FAB の挿入位置に使う。 */
  lastFocusedBlockUuid: string | null;
}

const state: EditorState = {
  list: [],
  search: '',
  current: null,
  currentSet: null,
  saveTimers: new Map(),
  loadingMermaid: null,
  bookmarkPickerOpen: false,
  lastFocusedBlockUuid: null,
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
  { type: 'canvas', label: 'お絵描きキャンバス', icon: '✏️' },
  { type: 'divider', label: '区切り', icon: '—' },
  { type: 'bookmark_embed', label: 'Bookmark を挿入', icon: '🔖' },
  { type: 'note_link', label: 'Note を挿入', icon: '📓' },
];

/// 通常ノートで slash menu と別枠に出す「フローティング挿入」 アクション。
/// floating_text はブロック種別変更ではなく overlay レイヤーに新規追加するため
/// 種別リストではなく action 経由で扱う。
const FLOATING_INSERT_ACTION = 'insert-floating' as const;

/// 「ブロック種別」 リストの後に置く別アクション (= 種別変更ではない)。
/// data-action で識別。
const BLOCK_EXTRA_ACTIONS: ReadonlyArray<{ action: string; label: string; icon: string }> = [
  { action: 'url-embed',          label: 'URL を埋め込む (Notion 風)', icon: '🌐' },
  { action: FLOATING_INSERT_ACTION, label: 'フローティング注釈を追加',  icon: '📍' },
  { action: 'bg-color',           label: '背景色を変える',              icon: '🎨' },
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

  const sidebarToggle = byId<HTMLButtonElement>('notesSidebarToggle');
  if (sidebarToggle) sidebarToggle.addEventListener('click', () => toggleNotesSidebar());

  // モバイル用 FAB: いま居るブロックの次にブロックを追加する挿入メニュー。
  const mobileFab = byId<HTMLButtonElement>('notesMobileFab');
  if (mobileFab) {
    mobileFab.addEventListener('click', (ev) => {
      ev.stopPropagation();   // closeOnOutside の即時クローズを回避
      openInsertBlockMenu(mobileFab);
    });
  }

  // 初期状態: モバイルでも note 未選択なら sidebar を開いて起動 (= ノート選択
  // メニューから始まる)。 PC は常に開。 note を選んだ時点で closeNotesSidebarOnMobile
  // が走って閉じる。
  const layout0 = byId<HTMLDivElement>('notesLayout');
  if (layout0) {
    layout0.classList.add('notes-sidebar-open');
  }
  // backdrop タップ (mobile) → drawer を閉じる
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    if (!t || !isMobileNotesViewport()) return;
    if (t.classList?.contains('notes-sidebar-backdrop')) {
      const layout = byId<HTMLDivElement>('notesLayout');
      layout?.classList.remove('notes-sidebar-open');
    }
  });

  document.addEventListener('selectionchange', updateSelectionToolbar);
  document.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && !t.closest('.note-toolbar') && !t.closest('.note-block-content')) {
      hideSelectionToolbar();
    }
  });
  // inline mention chip クリック → 対応リソースを開く
  document.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement | null)?.closest('.memoria-mention') as HTMLAnchorElement | null;
    if (!t) return;
    const bid = t.dataset.bookmarkId;
    const nuuid = t.dataset.noteUuid;
    if (bid) {
      e.preventDefault();
      window.open(`/api/bookmarks/${bid}/html`, '_blank', 'noopener,noreferrer');
    } else if (nuuid) {
      e.preventDefault();
      void openNote(nuuid);
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
  state.lastFocusedBlockUuid = note.blocks?.[note.blocks.length - 1]?.uuid ?? null;
  renderEditor();
  renderSidebar();
  closeNotesSidebarOnMobile();
  updateMobileFabVisibility();
  void loadOwnCommentSet();
}

function updateMobileFabVisibility(): void {
  const fab = byId<HTMLButtonElement>('notesMobileFab');
  if (!fab) return;
  // note が開かれているとき (= state.current あり) だけ表示。 PC は CSS @media で
  // どのみち非表示になっているので、 hidden 属性での出し分けは主に「note 未選択」
  // 用途。
  fab.hidden = !state.current;
}

function isMobileNotesViewport(): boolean {
  return window.matchMedia('(max-width: 760px)').matches;
}

function toggleNotesSidebar(): void {
  const layout = byId<HTMLDivElement>('notesLayout');
  if (!layout) return;
  layout.classList.toggle('notes-sidebar-open');
}

function closeNotesSidebarOnMobile(): void {
  if (!isMobileNotesViewport()) return;
  const layout = byId<HTMLDivElement>('notesLayout');
  if (layout) layout.classList.remove('notes-sidebar-open');
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
    : `<div class="note-doc-toolbar">
         <button class="ghost" id="addDocFloatingBtn" title="本文上に絶対配置のフローティング注釈を追加">📍 フローティングを追加</button>
       </div>
       <div class="note-blocks-wrap">
         <div class="note-blocks" id="noteBlocks"></div>
         <div class="note-doc-floating-overlay" id="noteDocFloatingOverlay"></div>
       </div>
       <div class="note-add-block">
         <button class="ghost" id="noteAddBlockBtn">+ ブロックを追加</button>
         <button class="ghost" id="noteAddSpecialBtn" title="種類を選んで挿入 (テキスト含む全ブロック)">+ 特殊ブロック</button>
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
    const addSpecialBtn = byId<HTMLButtonElement>('noteAddSpecialBtn');
    if (addSpecialBtn) addSpecialBtn.addEventListener('click', () => openSpecialBlockPicker(addSpecialBtn));
    const addDocFloat = byId<HTMLButtonElement>('addDocFloatingBtn');
    if (addDocFloat) addDocFloat.addEventListener('click', () => void insertDocFloatingBlock());
    renderAllBlocks();
    renderDocFloatingOverlay();
  }
}

// ── 特殊ブロックピッカー (text を含む全ブロックを選んで末尾に挿入) ─────────
function openSpecialBlockPicker(anchor: HTMLElement): void {
  closeBlockMenu();
  const isMobile = isMobileNotesViewport();
  const menu = document.createElement('div');
  menu.className = `note-block-menu note-special-block-menu${isMobile ? ' note-special-block-sheet' : ''}`;
  const types = BLOCK_TYPE_OPTIONS; // text 含む全種別
  menu.innerHTML = `
    ${isMobile ? `
      <div class="nbm-sheet-head">
        <span>ブロックを挿入</span>
        <button class="nbm-sheet-close" type="button" aria-label="閉じる">×</button>
      </div>` : ''}
    <div class="nbm-section">挿入するブロック種別</div>
    ${types.map((o) => `
      <button class="nbm-item" data-type="${o.type}"><span class="nbm-icon">${o.icon}</span>${o.label}</button>
    `).join('')}
    <div class="nbm-section">特殊</div>
    <button class="nbm-item" data-action="${FLOATING_INSERT_ACTION}"><span class="nbm-icon">📍</span>フローティング注釈</button>
  `;
  // mobile では body 直下、 backdrop 付き bottom-sheet
  let backdrop: HTMLDivElement | null = null;
  if (isMobile) {
    backdrop = document.createElement('div');
    backdrop.className = 'note-sheet-backdrop';
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', () => closeBlockMenu());
  }
  document.body.appendChild(menu);
  if (!isMobile) {
    const r = anchor.getBoundingClientRect();
    const top = Math.max(8, r.top + window.scrollY - 8 - 320);
    menu.style.left = `${Math.max(8, r.left)}px`;
    menu.style.top = `${top}px`;
  }
  menu.querySelector<HTMLButtonElement>('.nbm-sheet-close')?.addEventListener('click', () => closeBlockMenu());
  // closeBlockMenu が backdrop も巻き取れるよう、 backdrop ref を menu に保持
  (menu as unknown as { _backdrop?: HTMLElement })._backdrop = backdrop ?? undefined;
  openMenu = menu;
  menu.querySelectorAll<HTMLButtonElement>('.nbm-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.type as NoteBlockType | undefined;
      const a = btn.dataset.action;
      closeBlockMenu();
      if (a === FLOATING_INSERT_ACTION) {
        if (state.current?.kind === 'bookmark') void insertFloatingBlock();
        else void insertDocFloatingBlock();
        return;
      }
      if (!t) return;
      if (t === 'bookmark_embed' || t === 'note_link') {
        // 末尾に空 text を作ってから picker (= 既存の change-type 経路に合流)
        void appendBlock('text').then(() => {
          const last = state.current?.blocks[state.current.blocks.length - 1];
          if (!last) return;
          if (t === 'bookmark_embed') openBookmarkPickerForBlock(last.uuid);
          else openNotePickerForBlock(last.uuid);
        });
        return;
      }
      void appendBlock(t);
    });
  });
  setTimeout(() => {
    document.addEventListener('click', closeOnOutside, { once: true });
  }, 0);
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
    // floating_text は通常ノートでも overlay 側でレンダリング (本文線形フローには出さない)
    if (b.block_type === 'floating_text') continue;
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
  // block 単位の背景色 (Notion ライク)。 data.bgColor を最優先で apply。
  const data = parseData(block);
  if (data.bgColor) {
    el.style.backgroundColor = data.bgColor;
    el.classList.add('nb-bg-tinted');
  }
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
    case 'canvas':     return buildCanvasBlock(block);
    case 'divider':    return buildDividerBlock(block);
    case 'bookmark_embed': return buildBookmarkEmbed(block);
    case 'note_link':      return buildNoteLink(block);
    case 'floating_text': {
      // floating_text は overlay 側でレンダリング済み (renderDocFloatingOverlay /
      // renderFloatingBlocks)。 ここに来るのは本来想定外なので空要素を返す。
      return document.createElement('div');
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
  el.innerHTML = renderNoteText(block.text);
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
  li.innerHTML = renderNoteText(block.text);
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
  span.innerHTML = renderNoteText(block.text);
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

// ── Canvas (drawing) block ────────────────────────────────────────────────

const CANVAS_DEFAULT_W = 800;
const CANVAS_DEFAULT_H = 460;
const CANVAS_PEN_PRESETS: ReadonlyArray<{ color: string; label: string }> = [
  { color: '#222222', label: '黒' },
  { color: '#e6553a', label: '赤' },
  { color: '#2a6df4', label: '青' },
  { color: '#3ac26a', label: '緑' },
  { color: '#f6b73c', label: '黄' },
  { color: '#7b3ff2', label: '紫' },
];
const CANVAS_WIDTH_PRESETS: readonly number[] = [1, 2, 4, 8, 16];

interface CanvasUiState {
  color: string;
  width: number;
  tool: 'pen' | 'eraser';
}

function buildCanvasBlock(block: NoteBlockRow): HTMLElement {
  const data = parseData(block);
  const w = data.canvasWidth ?? CANVAS_DEFAULT_W;
  const h = data.canvasHeight ?? CANVAS_DEFAULT_H;
  const paths: Array<{ points: string; color: string; width: number }> =
    Array.isArray(data.paths) ? data.paths.map((p) => ({ points: p.points, color: p.color, width: p.width })) : [];

  const wrap = document.createElement('div');
  wrap.className = 'note-canvas-block';

  const ui: CanvasUiState = { color: '#222222', width: 2, tool: 'pen' };

  const toolbar = document.createElement('div');
  toolbar.className = 'ncb-toolbar';
  toolbar.innerHTML = `
    <div class="ncb-tool-group">
      <button class="ncb-tool ncb-pen active" data-tool="pen" title="ペン">✏️</button>
      <button class="ncb-tool ncb-eraser" data-tool="eraser" title="消しゴム (ストローク単位)">🧽</button>
    </div>
    <div class="ncb-tool-group ncb-colors">
      ${CANVAS_PEN_PRESETS.map((p, i) => `
        <button class="ncb-color${i === 0 ? ' active' : ''}" data-color="${p.color}"
          style="background:${p.color}" title="${p.label}"></button>
      `).join('')}
      <input type="color" class="ncb-color-custom" value="#222222" title="カスタム色" />
    </div>
    <div class="ncb-tool-group ncb-widths">
      ${CANVAS_WIDTH_PRESETS.map((px) => `
        <button class="ncb-width${px === 2 ? ' active' : ''}" data-width="${px}" title="${px}px">
          <span style="width:${Math.min(20, px * 2)}px;height:${Math.min(20, px * 2)}px;background:#333;border-radius:50%;display:inline-block;"></span>
        </button>
      `).join('')}
    </div>
    <div class="ncb-tool-group ncb-actions">
      <button class="ncb-undo ghost" title="最後のストロークを取り消し">↶ 戻す</button>
      <button class="ncb-clear ghost danger" title="全消去">🗑 全消去</button>
    </div>
  `;
  wrap.appendChild(toolbar);

  const stage = document.createElement('div');
  stage.className = 'ncb-stage';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'ncb-svg');
  svg.style.touchAction = 'none';
  stage.appendChild(svg);
  wrap.appendChild(stage);

  const repaint = (): void => {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    for (const p of paths) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      el.setAttribute('points', p.points);
      el.setAttribute('stroke', p.color);
      el.setAttribute('stroke-width', String(p.width));
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke-linecap', 'round');
      el.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(el);
    }
  };
  repaint();

  let saveTimer = 0;
  const persist = (): void => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void saveBlockData(block, { ...parseData(block), paths, canvasWidth: w, canvasHeight: h });
    }, 250);
  };

  // ── ツールバー操作 ──
  toolbar.querySelectorAll<HTMLButtonElement>('.ncb-tool').forEach((b) => {
    b.addEventListener('click', () => {
      ui.tool = (b.dataset.tool as CanvasUiState['tool']) ?? 'pen';
      toolbar.querySelectorAll('.ncb-tool').forEach((x) => x.classList.toggle('active', x === b));
    });
  });
  toolbar.querySelectorAll<HTMLButtonElement>('.ncb-color').forEach((b) => {
    b.addEventListener('click', () => {
      ui.color = b.dataset.color || '#222222';
      toolbar.querySelectorAll('.ncb-color').forEach((x) => x.classList.toggle('active', x === b));
      ui.tool = 'pen';
      toolbar.querySelectorAll('.ncb-tool').forEach((x) => x.classList.toggle('active', (x as HTMLElement).dataset.tool === 'pen'));
    });
  });
  const customColor = toolbar.querySelector<HTMLInputElement>('.ncb-color-custom');
  if (customColor) {
    customColor.addEventListener('input', () => {
      ui.color = customColor.value;
      toolbar.querySelectorAll('.ncb-color').forEach((x) => x.classList.remove('active'));
      ui.tool = 'pen';
    });
  }
  toolbar.querySelectorAll<HTMLButtonElement>('.ncb-width').forEach((b) => {
    b.addEventListener('click', () => {
      ui.width = Number(b.dataset.width) || 2;
      toolbar.querySelectorAll('.ncb-width').forEach((x) => x.classList.toggle('active', x === b));
    });
  });
  toolbar.querySelector<HTMLButtonElement>('.ncb-undo')!.addEventListener('click', () => {
    if (paths.length === 0) return;
    paths.pop();
    repaint();
    persist();
  });
  toolbar.querySelector<HTMLButtonElement>('.ncb-clear')!.addEventListener('click', () => {
    if (paths.length === 0) return;
    if (!confirm('全てのストロークを消去しますか?')) return;
    paths.length = 0;
    repaint();
    persist();
  });

  // ── ポインタ描画 ──
  let drawing: { points: string[]; color: string; width: number; pointerId: number; el: SVGPolylineElement } | null = null;

  const ptToCanvas = (e: PointerEvent): { x: number; y: number } => {
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * w;
    const y = ((e.clientY - rect.top) / rect.height) * h;
    return { x: Math.round(x), y: Math.round(y) };
  };

  svg.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (ui.tool === 'eraser') {
      eraseAt(e);
      return;
    }
    try { svg.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const { x, y } = ptToCanvas(e);
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    el.setAttribute('stroke', ui.color);
    el.setAttribute('stroke-width', String(ui.width));
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(el);
    drawing = { points: [`${x},${y}`], color: ui.color, width: ui.width, pointerId: e.pointerId, el };
    el.setAttribute('points', drawing.points.join(' '));
    e.preventDefault();
  });

  svg.addEventListener('pointermove', (e: PointerEvent) => {
    if (ui.tool === 'eraser' && (e.buttons & 1)) {
      eraseAt(e);
      return;
    }
    if (!drawing || drawing.pointerId !== e.pointerId) return;
    const { x, y } = ptToCanvas(e);
    const last = drawing.points[drawing.points.length - 1] || '';
    const lastXY = last.split(',').map(Number);
    if (lastXY.length === 2 && Math.abs(lastXY[0] - x) < 2 && Math.abs(lastXY[1] - y) < 2) return;
    drawing.points.push(`${x},${y}`);
    drawing.el.setAttribute('points', drawing.points.join(' '));
  });

  const finish = (e: PointerEvent): void => {
    if (!drawing || drawing.pointerId !== e.pointerId) return;
    try { svg.releasePointerCapture(drawing.pointerId); } catch { /* ignore */ }
    if (drawing.points.length >= 2) {
      paths.push({ points: drawing.points.join(' '), color: drawing.color, width: drawing.width });
    } else {
      drawing.el.remove();
    }
    drawing = null;
    persist();
  };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', finish);
  svg.addEventListener('pointerleave', (e) => { if (drawing) finish(e); });

  function eraseAt(e: PointerEvent): void {
    const { x, y } = ptToCanvas(e);
    let removed = false;
    for (let i = paths.length - 1; i >= 0; i--) {
      if (pathHits(paths[i], x, y)) {
        paths.splice(i, 1);
        removed = true;
        break;
      }
    }
    if (removed) {
      repaint();
      persist();
    }
  }

  return wrap;
}

function pathHits(path: { points: string; width: number }, x: number, y: number): boolean {
  const tol = Math.max(6, path.width + 4);
  const tol2 = tol * tol;
  let prev: [number, number] | null = null;
  for (const tok of path.points.split(/\s+/)) {
    const xy = tok.split(',').map(Number);
    if (xy.length !== 2 || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue;
    const cur: [number, number] = [xy[0], xy[1]];
    if (prev) {
      // 線分への距離 (近似: 端点 + 中点距離だけ判定)
      if (segDistSq(prev, cur, x, y) <= tol2) return true;
    } else {
      const dx = cur[0] - x, dy = cur[1] - y;
      if (dx * dx + dy * dy <= tol2) return true;
    }
    prev = cur;
  }
  return false;
}

function segDistSq(a: [number, number], b: [number, number], px: number, py: number): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ex = px - a[0], ey = py - a[1];
    return ex * ex + ey * ey;
  }
  let t = ((px - a[0]) * dx + (py - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const fx = a[0] + t * dx, fy = a[1] + t * dy;
  const ex = px - fx, ey = py - fy;
  return ex * ex + ey * ey;
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

function buildBookmarkEmbed(block: NoteBlockRow): HTMLElement {
  const data = parseData(block);
  const card = document.createElement('div');
  card.className = 'note-embed-card note-embed-bookmark';
  const bid = data.bookmark_id ?? null;
  const url = data.bookmark_url ?? '';
  const title = data.title ?? url;
  const summary = data.summary ?? '';
  const image = data.image ?? '';
  const siteName = data.site_name ?? '';
  // image 付きは Notion 風の横長 preview card。 image 無しは従来の icon + text。
  if (image) {
    card.classList.add('note-embed-bookmark-rich');
    card.innerHTML = `
      <div class="ne-thumb"><img src="${escapeHtml(image)}" alt="" loading="lazy" /></div>
      <div class="ne-body">
        <div class="ne-title">${escapeHtml(title)}</div>
        ${summary ? `<div class="ne-summary muted">${escapeHtml(summary)}</div>` : ''}
        <div class="ne-meta">
          ${siteName ? `<span class="ne-site muted">${escapeHtml(siteName)}</span>` : ''}
          <span class="ne-url muted">${escapeHtml(url)}</span>
          ${bid != null ? `<a class="ne-action" href="/api/bookmarks/${bid}/html" target="_blank" rel="noopener noreferrer">📂 キャッシュ</a>` : ''}
          ${url ? `<a class="ne-action" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">🌐 元のページ</a>` : ''}
        </div>
      </div>
    `;
  } else {
    card.innerHTML = `
      <div class="ne-icon">🔖</div>
      <div class="ne-body">
        <div class="ne-title">${escapeHtml(title)}</div>
        ${summary ? `<div class="ne-summary muted">${escapeHtml(summary)}</div>` : ''}
        <div class="ne-meta">
          ${siteName ? `<span class="ne-site muted">${escapeHtml(siteName)}</span>` : ''}
          <span class="ne-url muted">${escapeHtml(url)}</span>
          ${bid != null ? `<a class="ne-action" href="/api/bookmarks/${bid}/html" target="_blank" rel="noopener noreferrer">📂 キャッシュを開く</a>` : ''}
          ${url ? `<a class="ne-action" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">🌐 元のページ</a>` : ''}
        </div>
      </div>
    `;
  }
  return card;
}

function buildNoteLink(block: NoteBlockRow): HTMLElement {
  const data = parseData(block);
  const card = document.createElement('div');
  card.className = 'note-embed-card note-embed-note';
  const nid = data.note_id ?? '';
  const title = data.title ?? '無題';
  card.innerHTML = `
    <div class="ne-icon">📓</div>
    <div class="ne-body">
      <div class="ne-title">${escapeHtml(title)}</div>
      <div class="ne-meta muted">note ${nid ? nid.slice(0, 8) + '…' : '?'}</div>
    </div>
    <button class="ne-open" data-note-id="${escapeHtml(nid)}">→ 開く</button>
  `;
  card.querySelector<HTMLButtonElement>('.ne-open')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (nid) void openNote(nid);
  });
  card.addEventListener('dblclick', () => { if (nid) void openNote(nid); });
  return card;
}

function parseData(block: NoteBlockRow): BlockData {
  if (!block.data_json) return {};
  try { return JSON.parse(block.data_json) as BlockData; } catch { return {}; }
}

function renderNoteText(text: string): string {
  return renderInline(text).replace(/\r\n|\r|\n/g, '<br>');
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
  el.addEventListener('focus', () => { state.lastFocusedBlockUuid = block.uuid; });
  el.addEventListener('input', () => {
    if (state.saveTimers.has(block.uuid)) window.clearTimeout(state.saveTimers.get(block.uuid));
    state.saveTimers.set(block.uuid, window.setTimeout(flush, SAVE_DEBOUNCE_MS));
  });
  el.addEventListener('keydown', (ev) => handleEditorKey(ev, block));
}

// ── caret 位置判定 (ArrowUp/Down で前後ブロックに移動するか決めるのに使う) ──
//
// contenteditable 内の Selection を見て、 caret が要素の先頭 / 末尾にあるかを返す。
// 先頭にあって ArrowUp なら前の block に移動、 末尾にあって ArrowDown なら次に
// 移動。 code / mermaid のような多行ブロックは「最初の行 / 最後の行」 にいる
// ときだけ block 越え移動になる。
function caretAtEdges(el: HTMLElement): { atStart: boolean; atEnd: boolean } {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
    return { atStart: false, atEnd: false };
  }
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return { atStart: false, atEnd: false };
  // collapsed caret の左側 / 右側に何かテキストが残っているかで判定。
  const before = document.createRange();
  before.selectNodeContents(el);
  before.setEnd(range.startContainer, range.startOffset);
  const atStart = before.toString().length === 0;
  const after = document.createRange();
  after.selectNodeContents(el);
  after.setStart(range.endContainer, range.endOffset);
  const atEnd = after.toString().length === 0;
  return { atStart, atEnd };
}

function focusBlock(uuid: string, place: 'start' | 'end'): boolean {
  const target = document.querySelector<HTMLElement>(`[data-block-uuid="${uuid}"] .note-block-content`);
  if (!target) return false;
  target.focus();
  // caret を端に置く (Enter/Backspace の挙動と整合)
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(place === 'start');
  const sel = window.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  return true;
}

function siblingBlockUuid(currentUuid: string, direction: -1 | 1): string | null {
  const blocks = state.current?.blocks ?? [];
  const idx = blocks.findIndex((b) => b.uuid === currentUuid);
  if (idx < 0) return null;
  const next = blocks[idx + direction];
  return next?.uuid ?? null;
}

function htmlToStorageText(el: HTMLElement): string {
  return sanitizeInlineHtml(el.innerHTML)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r\n|\r/g, '\n');
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
  // ArrowUp / ArrowDown: caret が先頭 / 末尾なら前後ブロックの contenteditable に
  // focus を移す。 中間にいるときは default 動作 (= contenteditable 内 caret 移動)。
  // 修飾キー (Shift / Alt / Meta) が押されている場合は範囲選択 / 専用ショート
  // カットの可能性があるので何もしない。
  if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && !ev.shiftKey && !ev.altKey && !ev.metaKey && !ev.ctrlKey) {
    const el = ev.currentTarget as HTMLElement;
    const edges = caretAtEdges(el);
    if (ev.key === 'ArrowUp' && edges.atStart) {
      const prev = siblingBlockUuid(block.uuid, -1);
      if (prev && focusBlock(prev, 'end')) { ev.preventDefault(); return; }
    }
    if (ev.key === 'ArrowDown' && edges.atEnd) {
      const next = siblingBlockUuid(block.uuid, 1);
      if (next && focusBlock(next, 'start')) { ev.preventDefault(); return; }
    }
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
  // floating_text はブロック種別変更ではなく overlay 追加 (action 経由) で扱う
  // → 種別リストには出さない。 通常ノート / bookmark ノート両方で同じ扱い。
  const typeOptions = BLOCK_TYPE_OPTIONS.filter((o) => o.type !== 'floating_text');
  menu.innerHTML = `
    <div class="nbm-section">ブロック種別</div>
    ${typeOptions.map((o) => `
      <button class="nbm-item" data-type="${o.type}"><span class="nbm-icon">${o.icon}</span>${o.label}</button>
    `).join('')}
    <div class="nbm-section">挿入 / 装飾</div>
    ${BLOCK_EXTRA_ACTIONS.map((o) => `
      <button class="nbm-item" data-action="${o.action}"><span class="nbm-icon">${o.icon}</span>${o.label}</button>
    `).join('')}
    <div class="nbm-section">操作</div>
    <button class="nbm-item nbm-action" data-action="comment">💬 このブロックにコメント</button>
    <button class="nbm-item nbm-danger" data-action="delete">🗑 削除</button>
  `;
  document.body.appendChild(menu);
  positionBlockMenu(menu, anchor);
  openMenu = menu;
  menu.querySelectorAll<HTMLButtonElement>('.nbm-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.type as NoteBlockType | undefined;
      const a = btn.dataset.action;
      const handleAnchor = anchor;
      closeBlockMenu();
      if (t === 'bookmark_embed') openBookmarkPickerForBlock(blockUuid);
      else if (t === 'note_link') openNotePickerForBlock(blockUuid);
      else if (t) void changeBlockType(blockUuid, t);
      else if (a === 'delete') void removeBlock(blockUuid);
      else if (a === 'comment') void quickComment(blockUuid);
      else if (a === 'url-embed') void promptUrlEmbed(blockUuid);
      else if (a === FLOATING_INSERT_ACTION) {
        if (state.current?.kind === 'bookmark') void insertFloatingBlock();
        else void insertDocFloatingBlock();
      }
      else if (a === 'bg-color') openBlockBgColorPicker(blockUuid, handleAnchor);
    });
  });
  setTimeout(() => {
    document.addEventListener('click', closeOnOutside, { once: true });
  }, 0);
}

// スマホ FAB 用「ブロック追加」 メニュー。 既存の openBlockMenu と違って
// 「現在ブロックの種別変更」 ではなく「現在ブロックの次に新規ブロックを追加」
// するための専用フロー。
function openInsertBlockMenu(anchor: HTMLElement): void {
  if (!state.current) return;
  closeBlockMenu();
  const blocks = state.current.blocks;
  // 挿入位置の決定: 直前 focus → 最終ブロック → どれも無ければ undefined (=末尾)
  const afterUuid = (state.lastFocusedBlockUuid && blocks.some((b) => b.uuid === state.lastFocusedBlockUuid))
    ? state.lastFocusedBlockUuid
    : blocks[blocks.length - 1]?.uuid;
  const menu = document.createElement('div');
  menu.className = 'note-block-menu';
  const typeOptions = BLOCK_TYPE_OPTIONS.filter((o) => o.type !== 'floating_text');
  menu.innerHTML = `
    <div class="nbm-section">追加するブロック種別</div>
    ${typeOptions.map((o) => `
      <button class="nbm-item" data-type="${o.type}"><span class="nbm-icon">${o.icon}</span>${o.label}</button>
    `).join('')}
  `;
  document.body.appendChild(menu);
  positionBlockMenu(menu, anchor);
  openMenu = menu;
  menu.querySelectorAll<HTMLButtonElement>('.nbm-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.type as NoteBlockType | undefined;
      closeBlockMenu();
      if (!t) return;
      if (t === 'bookmark_embed' || t === 'note_link') {
        // 既存パターン: 空 text を挿入してから picker → picker 側で change-type
        void appendBlock('text', afterUuid).then(() => {
          const list = state.current?.blocks ?? [];
          const idx = afterUuid ? list.findIndex((b) => b.uuid === afterUuid) : -1;
          const inserted = idx >= 0 ? list[idx + 1] : list[list.length - 1];
          if (!inserted) return;
          if (t === 'bookmark_embed') openBookmarkPickerForBlock(inserted.uuid);
          else openNotePickerForBlock(inserted.uuid);
        });
        return;
      }
      void appendBlock(t, afterUuid);
    });
  });
  setTimeout(() => {
    document.addEventListener('click', closeOnOutside, { once: true });
  }, 0);
}

// メニューを viewport にクランプして配置する。
// 既定: anchor の下に出す。 下が見切れる場合は上に。 左右もはみ出さないようクランプ。
function positionBlockMenu(menu: HTMLElement, anchor: HTMLElement): void {
  const margin = 8;
  // 一度フィットさせて寸法を取得 (position: fixed + 左上に仮配置)
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.style.maxHeight = `${Math.max(160, window.innerHeight - 2 * margin)}px`;
  menu.style.overflowY = 'auto';
  const r = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  // 横位置: anchor 左を基準に右側にはみ出さないようクランプ
  let left = r.left;
  if (left + m.width > window.innerWidth - margin) left = window.innerWidth - m.width - margin;
  if (left < margin) left = margin;
  // 縦位置: 下に出して入るなら下、 入らなければ上に出す。 両方無理なら上端に貼り付け
  const spaceBelow = window.innerHeight - r.bottom - margin;
  const spaceAbove = r.top - margin;
  let top: number;
  if (m.height <= spaceBelow) {
    top = r.bottom + 4;
  } else if (m.height <= spaceAbove) {
    top = r.top - m.height - 4;
  } else if (spaceBelow >= spaceAbove) {
    top = r.bottom + 4;
    menu.style.maxHeight = `${Math.max(120, spaceBelow)}px`;
  } else {
    top = margin;
    menu.style.maxHeight = `${Math.max(120, spaceAbove + r.height)}px`;
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function closeOnOutside(e: MouseEvent): void {
  if (openMenu && !openMenu.contains(e.target as Node)) closeBlockMenu();
}

function closeBlockMenu(): void {
  if (openMenu) {
    const bd = (openMenu as unknown as { _backdrop?: HTMLElement })._backdrop;
    if (bd) bd.remove();
    openMenu.remove();
    openMenu = null;
  }
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
    <button data-cmd="color" title="文字色">🎨</button>
    <button data-cmd="bg" title="ハイライト">🖍</button>
    <button data-cmd="mention-bookmark" title="bookmark を inline 挿入">🔖</button>
    <button data-cmd="mention-note" title="note を inline 挿入">📓</button>
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
  if (cmd === 'color') return showColorPicker(range, 'fg');
  if (cmd === 'bg')    return showColorPicker(range, 'bg');
  if (cmd === 'mention-bookmark') return openInlineBookmarkPicker(range);
  if (cmd === 'mention-note')     return openInlineNotePicker(range);
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

/// `mode='fg'` (文字色) / `'bg'` (ハイライト)。
function showColorPicker(range: Range, mode: 'fg' | 'bg' = 'fg'): void {
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
      applyColor(range, c, mode);
      popup.remove();
      hideSelectionToolbar();
    });
  });
  popup.querySelector<HTMLButtonElement>('#ncpApply')!.addEventListener('click', () => {
    const v = popup.querySelector<HTMLInputElement>('#ncpCustom')!.value;
    applyColor(range, v, mode);
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

function applyColor(range: Range, color: string, mode: 'fg' | 'bg' = 'fg'): void {
  if (!color) {
    const text = range.toString();
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
  } else {
    wrapRangeWith(range, (s) => {
      const span = document.createElement('span');
      if (mode === 'bg') span.style.backgroundColor = color;
      else span.style.color = color;
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

// ── Picker (block 内へ bookmark / note を埋め込む用) ───────────────────────

function openBookmarkPickerForBlock(blockUuid: string): void {
  if (!state.current || state.bookmarkPickerOpen) return;
  state.bookmarkPickerOpen = true;
  const overlay = document.createElement('div');
  overlay.className = 'note-bm-picker-overlay';
  overlay.innerHTML = `
    <div class="note-bm-picker">
      <div class="note-bm-picker-head">
        <h3>埋め込む bookmark を選択</h3>
        <button class="modal-close" id="bmpClose">×</button>
      </div>
      <input type="search" id="bmpSearch" placeholder="タイトル / URL で検索" />
      <ul id="bmpList" class="note-bm-list"></ul>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = (): void => { overlay.remove(); state.bookmarkPickerOpen = false; };
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
        if (!Number.isFinite(bid) || !state.current) return;
        void api.patchBlock(state.current.id, blockUuid, {
          block_type: 'bookmark_embed',
          data: { bookmark_id: bid },
        }).then(async () => {
          close();
          if (state.current) {
            state.current = await api.getNote(state.current.id);
            renderAllBlocks();
          }
        }).catch((e: unknown) => {
          alert(`bookmark embed 失敗: ${e instanceof Error ? e.message : String(e)}`);
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

function openNotePickerForBlock(blockUuid: string): void {
  if (!state.current) return;
  const overlay = document.createElement('div');
  overlay.className = 'note-bm-picker-overlay';
  overlay.innerHTML = `
    <div class="note-bm-picker">
      <div class="note-bm-picker-head">
        <h3>リンク先 note を選択</h3>
        <button class="modal-close" id="npClose">×</button>
      </div>
      <input type="search" id="npSearch" placeholder="タイトル / 本文で検索" />
      <ul id="npList" class="note-bm-list"></ul>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = (): void => { overlay.remove(); };
  overlay.querySelector<HTMLButtonElement>('#npClose')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const search = overlay.querySelector<HTMLInputElement>('#npSearch')!;
  const listEl = overlay.querySelector<HTMLUListElement>('#npList')!;
  const currentNoteId = state.current.id;
  let timer = 0;
  const refresh = async (): Promise<void> => {
    const res = await api.listNotes(search.value, 30);
    const items = res.items.filter((n) => n.id !== currentNoteId);
    listEl.innerHTML = items.map((n) => `
      <li class="note-bm-row" data-id="${escapeHtml(n.id)}">
        <div class="note-bm-title">${escapeHtml(n.title || '無題')}</div>
        <div class="note-bm-url muted">${escapeHtml((n.preview || '').slice(0, 80))}</div>
      </li>
    `).join('');
    listEl.querySelectorAll<HTMLLIElement>('.note-bm-row').forEach((li) => {
      li.addEventListener('click', () => {
        const nid = li.dataset.id || '';
        if (!nid || !state.current) return;
        void api.patchBlock(state.current.id, blockUuid, {
          block_type: 'note_link',
          data: { note_id: nid },
        }).then(async () => {
          close();
          if (state.current) {
            state.current = await api.getNote(state.current.id);
            renderAllBlocks();
          }
        }).catch((e: unknown) => {
          alert(`note link 失敗: ${e instanceof Error ? e.message : String(e)}`);
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

// ── Block 単位の背景色 (Notion ライク) ─────────────────────────────────────

function openBlockBgColorPicker(blockUuid: string, anchor: HTMLElement): void {
  if (!state.current) return;
  const block = state.current.blocks.find((b) => b.uuid === blockUuid);
  if (!block) return;
  closeBlockMenu();
  const popup = document.createElement('div');
  popup.className = 'note-color-popup';
  // 背景色用 palette は薄めの色を別途用意 (alpha 30% 風)
  const BG_PALETTE = [
    '', '#fde2e0', '#fdebc4', '#dcf2e2', '#dde9ff', '#ebdcfa',
    '#f2f2f2', '#1d2230',
  ];
  popup.innerHTML = `
    <div class="ncp-row">${BG_PALETTE.map((c) => `
      <button class="ncp-swatch" data-color="${c}" style="${c ? `background:${c}` : ''}" title="${c || '色クリア'}">${c ? '' : '×'}</button>
    `).join('')}</div>
    <div class="ncp-custom">
      <input type="color" id="nbcCustom" />
      <button class="ghost" id="nbcApply">適用</button>
    </div>
  `;
  document.body.appendChild(popup);
  const r = anchor.getBoundingClientRect();
  popup.style.left = `${r.left + window.scrollX}px`;
  popup.style.top = `${r.bottom + window.scrollY + 4}px`;
  const apply = (c: string): void => {
    const data = parseData(block);
    if (c) data.bgColor = c;
    else delete data.bgColor;
    void saveBlockData(block, data).then(async () => {
      if (state.current) {
        state.current = await api.getNote(state.current.id);
        renderAllBlocks();
      }
    });
  };
  popup.querySelectorAll<HTMLButtonElement>('.ncp-swatch').forEach((b) => {
    b.addEventListener('click', () => { apply(b.dataset.color || ''); popup.remove(); });
  });
  popup.querySelector<HTMLButtonElement>('#nbcApply')!.addEventListener('click', () => {
    const v = popup.querySelector<HTMLInputElement>('#nbcCustom')!.value;
    apply(v); popup.remove();
  });
  setTimeout(() => {
    document.addEventListener('click', function once(e) {
      if (!popup.contains(e.target as Node)) popup.remove();
      else document.addEventListener('click', once, { once: true });
    }, { once: true });
  }, 0);
}

// ── ad-hoc URL embed (Notion 風 /bookmark) ─────────────────────────────────

async function promptUrlEmbed(blockUuid: string): Promise<void> {
  if (!state.current) return;
  const url = prompt('埋め込みたい URL を入力してください:');
  if (!url || !/^https?:\/\//i.test(url)) {
    if (url) alert('http(s) URL を入力してください。');
    return;
  }
  let preview;
  try {
    preview = await api.urlPreview(url);
  } catch (e: unknown) {
    alert(`URL preview 失敗: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const data: BlockData = {
    bookmark_id: preview.bookmark_id,
    bookmark_url: preview.url,
    title: preview.title || preview.url,
    summary: preview.description || '',
    image: preview.image || undefined,
    site_name: preview.site_name || undefined,
  };
  try {
    await api.patchBlock(state.current.id, blockUuid, {
      block_type: 'bookmark_embed',
      data,
    });
    state.current = await api.getNote(state.current.id);
    renderAllBlocks();
  } catch (e: unknown) {
    alert(`URL 埋め込み失敗: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Inline mention picker (= sentence 中に bookmark / note の chip 挿入) ─────

function openInlineBookmarkPicker(range: Range): void {
  openInlineMentionPicker(range, async (q) => {
    const items = await api.searchBookmarks(q, 30);
    return items.map((b) => ({
      id: String(b.id),
      title: b.title || b.url,
      sub: b.url,
      kind: 'bookmark' as const,
    }));
  }, 'bookmark');
}

function openInlineNotePicker(range: Range): void {
  openInlineMentionPicker(range, async (q) => {
    const res = await api.listNotes(q, 30);
    return res.items.map((n) => ({
      id: n.id,
      title: n.title || '無題',
      sub: (n.preview || '').slice(0, 80),
      kind: 'note' as const,
    }));
  }, 'note');
}

interface InlinePickerItem { id: string; title: string; sub: string; kind: 'bookmark' | 'note' }

function openInlineMentionPicker(
  range: Range,
  search: (q: string) => Promise<InlinePickerItem[]>,
  defaultKind: 'bookmark' | 'note',
): void {
  hideSelectionToolbar();
  const popup = document.createElement('div');
  popup.className = 'note-mention-popup';
  popup.innerHTML = `
    <input type="search" id="nmpSearch" placeholder="${defaultKind === 'bookmark' ? 'bookmark を検索' : 'note を検索'}" />
    <ul id="nmpList" class="note-mention-list"></ul>
  `;
  document.body.appendChild(popup);
  const r = range.getBoundingClientRect();
  popup.style.left = `${Math.max(8, r.left + window.scrollX)}px`;
  popup.style.top = `${r.bottom + window.scrollY + 6}px`;
  const inp = popup.querySelector<HTMLInputElement>('#nmpSearch')!;
  const list = popup.querySelector<HTMLUListElement>('#nmpList')!;
  let timer = 0;
  // selection を維持するため独自に保存 (popup の input にフォーカスすると selection が飛ぶ)
  const savedRange = range.cloneRange();
  const refresh = async (): Promise<void> => {
    const items = await search(inp.value);
    list.innerHTML = items.map((it) => `
      <li class="nmp-row" data-id="${escapeHtml(it.id)}" data-kind="${it.kind}">
        <div class="nmp-title">${escapeHtml(it.title)}</div>
        ${it.sub ? `<div class="nmp-sub muted">${escapeHtml(it.sub)}</div>` : ''}
      </li>
    `).join('');
    list.querySelectorAll<HTMLLIElement>('.nmp-row').forEach((li) => {
      li.addEventListener('click', () => {
        const id = li.dataset.id || '';
        const kind = li.dataset.kind as 'bookmark' | 'note';
        const titleEl = li.querySelector<HTMLElement>('.nmp-title');
        const label = titleEl?.textContent || id;
        insertInlineMention(savedRange, kind, id, label);
        popup.remove();
      });
    });
  };
  inp.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(refresh, 180);
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') popup.remove();
  });
  setTimeout(() => {
    document.addEventListener('click', function once(e) {
      if (!popup.contains(e.target as Node)) popup.remove();
      else document.addEventListener('click', once, { once: true });
    }, { once: true });
  }, 0);
  void refresh();
  inp.focus();
}

function insertInlineMention(
  range: Range,
  kind: 'bookmark' | 'note',
  id: string,
  label: string,
): void {
  const a = document.createElement('a');
  a.className = `memoria-mention memoria-mention-${kind}`;
  if (kind === 'bookmark') a.dataset.bookmarkId = id;
  else a.dataset.noteUuid = id;
  a.textContent = `${kind === 'bookmark' ? '🔖' : '📓'} ${label}`;
  // selection があれば置き換え、 collapsed なら現在位置に挿入。
  range.deleteContents();
  range.insertNode(a);
  // chip の後に空白を追加して続けて入力できるようにする
  const sp = document.createTextNode(' ');
  a.after(sp);
  const r2 = document.createRange();
  r2.setStartAfter(sp);
  r2.collapse(true);
  const sel = window.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(r2); }
  triggerSaveForSelection(r2);
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
    void removeBlock(block.uuid).then(() => repaintFloatingForCurrentNote());
  });
  setupFloatingDrag(el, block);
  return el;
}

/// 通常ノート / bookmark ノートのどちらに居るかで overlay を再描画する。
function repaintFloatingForCurrentNote(): void {
  if (state.current?.kind === 'bookmark') renderFloatingBlocks();
  else renderDocFloatingOverlay();
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

// ── Doc floating overlay (通常ノート上の絶対配置注釈) ─────────────────────

function renderDocFloatingOverlay(): void {
  const overlay = byId<HTMLDivElement>('noteDocFloatingOverlay');
  if (!overlay || !state.current) return;
  overlay.innerHTML = '';
  const floats = state.current.blocks.filter((b) => b.block_type === 'floating_text');
  for (const fb of floats) overlay.appendChild(buildFloatingElement(fb));
}

async function insertDocFloatingBlock(): Promise<void> {
  if (!state.current) return;
  const wrap = document.querySelector<HTMLDivElement>('.note-blocks-wrap');
  let x = 40, y = 40;
  if (wrap) {
    x = Math.max(20, Math.round(wrap.clientWidth / 2 - 100));
    y = Math.max(20, wrap.scrollTop + 60);
  }
  await api.createBlock(state.current.id, {
    block_type: 'floating_text',
    text: '',
    data: { x, y, anchor: { kind: 'point' } },
  });
  state.current = await api.getNote(state.current.id);
  renderDocFloatingOverlay();
  const last = state.current.blocks.filter((b) => b.block_type === 'floating_text').pop();
  if (last) {
    const fb = document.querySelector<HTMLElement>(`.note-floating[data-block-uuid="${last.uuid}"] .nf-body`);
    if (fb) fb.focus();
  }
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
