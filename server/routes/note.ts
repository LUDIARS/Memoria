// /api/notes* — markdown ライク WYSIWYG ノート (UUID 管理) + bookmark base + per-user comment sets
// Spec: spec/interface/note.md / spec/feature/note.md / spec/feature/extension.md

import { Hono, type Context } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import {
  listNotes, getNote, listNoteBlocks, insertNote, updateNote, deleteNote,
  insertBlock, updateBlock, deleteBlock, reorderBlocks, getBlockByUuid,
  insertExternalChatMessage, getBookmark, findBookmarkByUrl, insertBookmark,
  getOrCreateCommentSet, listCommentSets, getCommentSet, deleteCommentSet,
  listComments, insertComment, updateComment, deleteComment,
  getExtensionRules, setExtensionRules,
  getPageMetadata,
} from '../db.js';
import { fetchUrlPreview } from '../url-preview.js';
import { reparseHtml } from '../parsers/index.js';

function hostnameOf(rawUrl: string): string {
  try { return new URL(rawUrl).hostname; } catch { return ''; }
}
import type {
  ExtensionRules, ExtensionChatDomain, ExtensionImplRule, ExtensionShoppingDomain,
  ExtensionNotionDomain,
} from '../db.js';
import type { NoteRow, NoteBlockRow, NoteBlockType, NoteKind } from '../db/types/note.js';
import { NOTE_BLOCK_TYPES } from '../db/types/note.js';
import type {
  NoteSummary, NoteWithBlocks, BlockCreateRequest,
  ChatExtractedMessage, ChatExtractionSource,
  ExtensionRulesUpdateRequest,
  CommentSetWithComments,
  NotionExtractedBlock,
} from '../api/types/note.js';

type Db = BetterSqlite3.Database;

const TITLE_MAX = 200;
const TEXT_MAX = 64 * 1024;
// canvas block の SVG path 配列を入れる余地を確保 (旧 32KB → 256KB)。
const DATA_MAX = 256 * 1024;
const TAG_MAX = 32;
const TAGS_MAX_COUNT = 16;
const COMMENT_TEXT_MAX = 16 * 1024;

export interface NoteRouterDeps {
  db: Db;
  htmlDir: string;
}

export function makeNoteRouter(deps: NoteRouterDeps): Hono {
  const { db, htmlDir } = deps;
  const r = new Hono();

  // ---- helpers --------------------------------------------------------------

  function parseTags(json: string | null | undefined): string[] {
    if (!json) return [];
    try {
      const v = JSON.parse(json) as unknown;
      return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
    } catch { return []; }
  }

  function sanitizeTags(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return input
      .map((t) => String(t).trim())
      .filter((t) => t.length > 0 && t.length <= TAG_MAX)
      .slice(0, TAGS_MAX_COUNT);
  }

  function rowToSummary(row: NoteRow & { block_count: number; preview: string }): NoteSummary {
    return {
      id: row.id,
      title: row.title,
      kind: row.kind as NoteKind,
      tags: parseTags(row.tags_json),
      bookmark_id: row.bookmark_id,
      bookmark_url: row.bookmark_url,
      source_kind: row.source_kind,
      source_ref: row.source_ref,
      block_count: row.block_count,
      preview: (row.preview ?? '').slice(0, 120),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  function rowToWithBlocks(row: NoteRow, blocks: NoteBlockRow[]): NoteWithBlocks {
    return {
      ...row,
      tags: parseTags(row.tags_json),
      blocks,
    };
  }

  function isValidBlockType(t: unknown): t is NoteBlockType {
    return typeof t === 'string' && (NOTE_BLOCK_TYPES as readonly string[]).includes(t);
  }

  function validateBlockPayload(body: BlockCreateRequest, partial = false): string | null {
    if (!partial || body.block_type !== undefined) {
      if (!isValidBlockType(body.block_type)) return 'invalid block_type';
    }
    if (typeof body.text === 'string' && body.text.length > TEXT_MAX) return `text exceeds ${TEXT_MAX}`;
    if (body.data != null && JSON.stringify(body.data).length > DATA_MAX) return `data exceeds ${DATA_MAX}`;
    return null;
  }

  /**
   * bookmark_embed / note_link の data_json を検証 + キャッシュ値で enrich する。
   * - bookmark_embed: bookmark_id が `bookmarks` に存在することを確認、 title / url / summary を埋める
   * - note_link: note_id が `notes` に存在することを確認、 title を埋める
   * - その他: data をそのまま返す
   */
  function enrichEmbedData(
    blockType: NoteBlockType,
    data: Record<string, unknown> | null | undefined,
  ): { ok: true; data: Record<string, unknown> | null } | { ok: false; error: string } {
    if (blockType === 'bookmark_embed') {
      const d = (data ?? {}) as Record<string, unknown>;
      const bid = Number(d.bookmark_id);
      if (!Number.isFinite(bid)) return { ok: false, error: 'bookmark_id required for bookmark_embed' };
      const bm = getBookmark(db, bid);
      if (!bm) return { ok: false, error: `bookmark ${bid} not found` };
      const enriched = {
        bookmark_id: bm.id,
        bookmark_url: bm.url,
        title: bm.title || bm.url,
        summary: (bm.summary ?? '').slice(0, 200),
      };
      return { ok: true, data: enriched };
    }
    if (blockType === 'note_link') {
      const d = (data ?? {}) as Record<string, unknown>;
      const nid = typeof d.note_id === 'string' ? d.note_id : '';
      if (!nid) return { ok: false, error: 'note_id required for note_link' };
      const target = getNote(db, nid);
      if (!target) return { ok: false, error: `note ${nid} not found` };
      const enriched = { note_id: nid, title: target.title || '無題' };
      return { ok: true, data: enriched };
    }
    return { ok: true, data: data ?? null };
  }

  // ---- notes (header) -------------------------------------------------------

  r.get('/api/notes', (c: Context) => {
    const q = c.req.query('q')?.trim() || '';
    const kindQ = c.req.query('kind')?.trim() || '';
    const bookmarkIdQ = c.req.query('bookmark_id');
    const bookmarkId = bookmarkIdQ ? Number(bookmarkIdQ) : null;
    const limit = Math.min(Number(c.req.query('limit') || 50), 200);
    const offset = Math.max(0, Number(c.req.query('offset') || 0));
    const { items, total } = listNotes(db, {
      q, kind: kindQ || null, bookmarkId, limit, offset,
    });
    return c.json({
      items: items.map(rowToSummary),
      total,
    });
  });

  r.get('/api/notes/:uuid', (c: Context) => {
    const id = c.req.param('uuid') ?? '';
    const note = getNote(db, id);
    if (!note) return c.json({ error: 'not found' }, 404);
    const blocks = listNoteBlocks(db, id);
    return c.json(rowToWithBlocks(note, blocks));
  });

  r.post('/api/notes', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as {
      title?: unknown; kind?: unknown; tags?: unknown;
      bookmark_id?: unknown; bookmark_url?: unknown;
      source_kind?: unknown; source_ref?: unknown;
      initial_blocks?: unknown;
    };
    let title = String(body.title ?? '').trim().slice(0, TITLE_MAX);
    let kind = (typeof body.kind === 'string' && body.kind.trim()) ? body.kind.trim() : 'doc';
    const tags = sanitizeTags(body.tags);
    let bookmarkId: number | null = null;
    let bookmarkUrl: string | null = typeof body.bookmark_url === 'string' ? body.bookmark_url : null;
    if (body.bookmark_id != null) {
      const bid = Number(body.bookmark_id);
      if (Number.isFinite(bid)) {
        const bm = getBookmark(db, bid);
        if (bm) {
          bookmarkId = bid;
          bookmarkUrl = bm.url;
          if (!title) title = bm.title || bm.url;
          if (!kind || kind === 'doc') kind = 'bookmark';
        }
      }
    }
    const id = insertNote(db, {
      title,
      kind,
      tags,
      bookmark_id: bookmarkId,
      bookmark_url: bookmarkUrl,
      source_kind: typeof body.source_kind === 'string' ? body.source_kind : null,
      source_ref: typeof body.source_ref === 'string' ? body.source_ref : null,
    });

    if (Array.isArray(body.initial_blocks)) {
      for (const raw of body.initial_blocks) {
        if (!raw || typeof raw !== 'object') continue;
        const b = raw as BlockCreateRequest;
        const err = validateBlockPayload(b);
        if (err) continue;
        try {
          insertBlock(db, id, {
            block_type: b.block_type,
            text: typeof b.text === 'string' ? b.text : '',
            data: b.data ?? null,
          });
        } catch { /* skip */ }
      }
    }

    const note = getNote(db, id)!;
    return c.json(note, 201);
  });

  r.patch('/api/notes/:uuid', async (c: Context) => {
    const id = c.req.param('uuid') ?? '';
    const cur = getNote(db, id);
    if (!cur) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof body.title === 'string') patch.title = body.title.slice(0, TITLE_MAX);
    if (typeof body.kind === 'string' && body.kind.trim()) patch.kind = body.kind.trim();
    if (Array.isArray(body.tags)) patch.tags = sanitizeTags(body.tags);
    // bookmark_id は null への解除のみ許可 (= bookmark を切り離す → kind を doc に戻す)。
    // 通常ノートに後から bookmark を貼り付けることはできない (spec: 通常ノートには bookmark を挟まない)。
    if (body.bookmark_id === null) {
      patch.bookmark_id = null;
      patch.bookmark_url = null;
      if (cur.kind === 'bookmark') patch.kind = 'doc';
    } else if (typeof body.bookmark_id === 'number') {
      return c.json({ error: 'bookmark_id can only be unset (null), not changed; create a new bookmark note instead' }, 400);
    }
    if (typeof body.source_kind === 'string' || body.source_kind === null) patch.source_kind = body.source_kind;
    if (typeof body.source_ref === 'string' || body.source_ref === null) patch.source_ref = body.source_ref;
    updateNote(db, id, patch);
    return c.json(getNote(db, id));
  });

  r.get('/api/notes/:uuid/bookmark-html', (c: Context) => {
    const id = c.req.param('uuid') ?? '';
    const note = getNote(db, id);
    if (!note) return c.text('not found', 404);
    if (note.kind !== 'bookmark' || note.bookmark_id == null) {
      return c.text('not a bookmark note', 404);
    }
    const bm = getBookmark(db, note.bookmark_id);
    if (!bm) return c.text('bookmark deleted', 404);
    const p = join(htmlDir, bm.html_path);
    if (!existsSync(p)) return c.text('html missing', 404);
    return c.body(readFileSync(p), 200, { 'Content-Type': 'text/html; charset=utf-8' });
  });

  r.delete('/api/notes/:uuid', (c: Context) => {
    const id = c.req.param('uuid') ?? '';
    if (!getNote(db, id)) return c.json({ error: 'not found' }, 404);
    deleteNote(db, id);
    return c.json({ ok: true });
  });

  // ---- blocks (UUID 経由) ---------------------------------------------------

  r.post('/api/notes/:uuid/blocks', async (c: Context) => {
    const noteId = c.req.param('uuid') ?? '';
    if (!getNote(db, noteId)) return c.json({ error: 'note not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as BlockCreateRequest & { after_block_uuid?: unknown };
    const err = validateBlockPayload(body);
    if (err) return c.json({ error: err }, 400);
    const enriched = enrichEmbedData(body.block_type, body.data ?? null);
    if (!enriched.ok) return c.json({ error: enriched.error }, 400);
    try {
      const block = insertBlock(db, noteId, {
        block_type: body.block_type,
        text: typeof body.text === 'string' ? body.text : '',
        data: enriched.data,
        after_block_uuid: typeof body.after_block_uuid === 'string' ? body.after_block_uuid : null,
      });
      return c.json(block, 201);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  r.patch('/api/notes/:uuid/blocks/:blockUuid', async (c: Context) => {
    const noteId = c.req.param('uuid') ?? '';
    const blockUuid = c.req.param('blockUuid') ?? '';
    if (!getNote(db, noteId)) return c.json({ error: 'note not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const err = validateBlockPayload(body as unknown as BlockCreateRequest, true);
    if (err) return c.json({ error: err }, 400);
    // embed 系は data 変更時に enrich + 検証
    if ('data' in body) {
      const targetType = (typeof body.block_type === 'string' && isValidBlockType(body.block_type))
        ? body.block_type
        : (getBlockByUuid(db, noteId, blockUuid)?.block_type ?? 'text');
      const enriched = enrichEmbedData(targetType, body.data as Record<string, unknown> | null | undefined);
      if (!enriched.ok) return c.json({ error: enriched.error }, 400);
      body.data = enriched.data;
    }
    try {
      const block = updateBlock(db, noteId, blockUuid, body);
      if (!block) return c.json({ error: 'block not found' }, 404);
      return c.json(block);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  r.delete('/api/notes/:uuid/blocks/:blockUuid', (c: Context) => {
    const noteId = c.req.param('uuid') ?? '';
    const blockUuid = c.req.param('blockUuid') ?? '';
    if (!getNote(db, noteId)) return c.json({ error: 'note not found' }, 404);
    const ok = deleteBlock(db, noteId, blockUuid);
    if (!ok) return c.json({ error: 'block not found' }, 404);
    return c.json({ ok: true });
  });

  r.post('/api/notes/:uuid/blocks/reorder', async (c: Context) => {
    const noteId = c.req.param('uuid') ?? '';
    if (!getNote(db, noteId)) return c.json({ error: 'note not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as { order?: unknown };
    if (!Array.isArray(body.order) || !body.order.every((s) => typeof s === 'string')) {
      return c.json({ error: 'order: string[] (block UUIDs) required' }, 400);
    }
    try {
      const blocks = reorderBlocks(db, noteId, body.order);
      return c.json({ ok: true, blocks });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  // ---- comment sets ---------------------------------------------------------

  r.get('/api/notes/:uuid/comment-sets', (c: Context) => {
    const noteId = c.req.param('uuid') ?? '';
    if (!getNote(db, noteId)) return c.json({ error: 'note not found' }, 404);
    const ownerQ = c.req.query('owner_user_id');
    let sets;
    if (ownerQ === undefined) {
      sets = listCommentSets(db, noteId);                      // すべて
    } else if (ownerQ === '' || ownerQ === 'null') {
      sets = listCommentSets(db, noteId, { ownerUserId: null }); // ローカル自分
    } else {
      sets = listCommentSets(db, noteId, { ownerUserId: ownerQ });
    }
    const items: CommentSetWithComments[] = sets.map((s) => ({ ...s, comments: listComments(db, s.id) }));
    return c.json({ items });
  });

  r.post('/api/notes/:uuid/comment-sets', async (c: Context) => {
    const noteId = c.req.param('uuid') ?? '';
    if (!getNote(db, noteId)) return c.json({ error: 'note not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as {
      owner_user_id?: unknown; owner_user_name?: unknown;
    };
    const set = getOrCreateCommentSet(db, noteId, {
      owner_user_id: typeof body.owner_user_id === 'string' ? body.owner_user_id : null,
      owner_user_name: typeof body.owner_user_name === 'string' ? body.owner_user_name : null,
    });
    return c.json(set, 201);
  });

  r.get('/api/notes/:uuid/comment-sets/:setUuid', (c: Context) => {
    const noteId = c.req.param('uuid') ?? '';
    const setId = c.req.param('setUuid') ?? '';
    if (!getNote(db, noteId)) return c.json({ error: 'note not found' }, 404);
    const set = getCommentSet(db, setId);
    if (!set || set.note_id !== noteId) return c.json({ error: 'set not found' }, 404);
    const out: CommentSetWithComments = { ...set, comments: listComments(db, setId) };
    return c.json(out);
  });

  r.delete('/api/notes/:uuid/comment-sets/:setUuid', (c: Context) => {
    const noteId = c.req.param('uuid') ?? '';
    const setId = c.req.param('setUuid') ?? '';
    const set = getCommentSet(db, setId);
    if (!set || set.note_id !== noteId) return c.json({ error: 'set not found' }, 404);
    deleteCommentSet(db, setId);
    return c.json({ ok: true });
  });

  // ---- comments inside a set ------------------------------------------------

  r.post('/api/notes/:uuid/comment-sets/:setUuid/comments', async (c: Context) => {
    const noteId = c.req.param('uuid') ?? '';
    const setId = c.req.param('setUuid') ?? '';
    const set = getCommentSet(db, setId);
    if (!set || set.note_id !== noteId) return c.json({ error: 'set not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as {
      text?: unknown; target_block_uuid?: unknown; data?: unknown; position?: unknown;
    };
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) return c.json({ error: 'text required' }, 400);
    if (text.length > COMMENT_TEXT_MAX) return c.json({ error: `text exceeds ${COMMENT_TEXT_MAX}` }, 400);
    const targetBlockUuid = typeof body.target_block_uuid === 'string' ? body.target_block_uuid : null;
    if (targetBlockUuid && !getBlockByUuid(db, noteId, targetBlockUuid)) {
      return c.json({ error: 'target_block_uuid does not exist on this note' }, 400);
    }
    const comment = insertComment(db, setId, {
      text,
      target_block_uuid: targetBlockUuid,
      data: (body.data && typeof body.data === 'object') ? body.data as Record<string, unknown> : null,
      position: typeof body.position === 'number' ? body.position : undefined,
    });
    return c.json(comment, 201);
  });

  r.patch('/api/notes/:uuid/comment-sets/:setUuid/comments/:commentUuid', async (c: Context) => {
    const noteId = c.req.param('uuid') ?? '';
    const setId = c.req.param('setUuid') ?? '';
    const commentId = c.req.param('commentUuid') ?? '';
    const set = getCommentSet(db, setId);
    if (!set || set.note_id !== noteId) return c.json({ error: 'set not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.text === 'string' && body.text.length > COMMENT_TEXT_MAX) {
      return c.json({ error: `text exceeds ${COMMENT_TEXT_MAX}` }, 400);
    }
    if (typeof body.target_block_uuid === 'string') {
      if (!getBlockByUuid(db, noteId, body.target_block_uuid)) {
        return c.json({ error: 'target_block_uuid does not exist on this note' }, 400);
      }
    }
    const updated = updateComment(db, setId, commentId, body);
    if (!updated) return c.json({ error: 'comment not found' }, 404);
    return c.json(updated);
  });

  r.delete('/api/notes/:uuid/comment-sets/:setUuid/comments/:commentUuid', (c: Context) => {
    const noteId = c.req.param('uuid') ?? '';
    const setId = c.req.param('setUuid') ?? '';
    const commentId = c.req.param('commentUuid') ?? '';
    const set = getCommentSet(db, setId);
    if (!set || set.note_id !== noteId) return c.json({ error: 'set not found' }, 404);
    const ok = deleteComment(db, setId, commentId);
    if (!ok) return c.json({ error: 'comment not found' }, 404);
    return c.json({ ok: true });
  });

  // ---- extension chat ingest ------------------------------------------------

  function isValidChatSource(s: unknown): s is ChatExtractionSource {
    return s === 'chatgpt' || s === 'claude' || s === 'gemini';
  }

  // chat メッセージ列から note を組み立てる共通ヘルパー (extension の from-chat と
  // bookmark の reparse の両方から呼ばれる)。 messages を external_chat にも保存する。
  function buildChatNote(opts: {
    source: ChatExtractionSource;
    url: string;
    title: string;
    conversation_id: string | null;
    memo: string;
    messages: ChatExtractedMessage[];
    record_external: boolean;
  }): { noteId: string; messagesSaved: number } {
    let messagesSaved = 0;
    if (opts.record_external) {
      for (const m of opts.messages) {
        if (!m || typeof m !== 'object') continue;
        const text = String(m.text ?? '').trim();
        if (!text) continue;
        try {
          insertExternalChatMessage(db, {
            source: opts.source,
            conversation_id: opts.conversation_id,
            role: m.role || null,
            content: text,
            metadata: { url: opts.url, title: opts.title, ts: m.ts ?? null },
          });
          messagesSaved++;
        } catch { /* skip */ }
      }
    }

    const noteTitle = opts.title || `${opts.source} chat (${new Date().toISOString().slice(0, 10)})`;
    const noteId = insertNote(db, {
      title: noteTitle,
      kind: 'chat',
      source_kind: 'chat',
      source_ref: opts.conversation_id || opts.url,
      tags: [opts.source],
    });

    const headerLines = [
      `**Source**: ${opts.source}`,
      opts.url ? `**URL**: <${opts.url}>` : '',
      `**Imported**: ${new Date().toISOString()}`,
      opts.memo ? `\n${opts.memo}` : '',
    ].filter(Boolean).join('\n');
    insertBlock(db, noteId, { block_type: 'quote', text: headerLines });

    for (const m of opts.messages) {
      if (!m || typeof m !== 'object') continue;
      const text = String(m.text ?? '').trim();
      if (!text) continue;
      const role = m.role || 'user';
      insertBlock(db, noteId, {
        block_type: 'heading_3',
        text: role === 'user' ? '👤 User' : role === 'assistant' ? '🤖 Assistant' : `📋 ${role}`,
      });
      insertBlock(db, noteId, { block_type: 'text', text });
    }
    return { noteId, messagesSaved };
  }

  r.post('/api/notes/from-chat', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as {
      source?: unknown; url?: unknown; conversation_id?: unknown; title?: unknown;
      messages?: unknown; also_create_note?: unknown; memo?: unknown;
    } | null;
    if (!body) return c.json({ error: 'body required' }, 400);
    if (!isValidChatSource(body.source)) return c.json({ error: 'source must be chatgpt|claude|gemini' }, 400);
    const url = typeof body.url === 'string' ? body.url : '';
    const title = typeof body.title === 'string' ? body.title.slice(0, TITLE_MAX) : '';
    const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : null;
    const memo = typeof body.memo === 'string' ? body.memo : '';
    const messages = Array.isArray(body.messages) ? body.messages as ChatExtractedMessage[] : [];
    const alsoCreateNote = body.also_create_note !== false;

    if (!alsoCreateNote) {
      // note は作らないが external_chat には残す
      let savedCount = 0;
      for (const m of messages) {
        if (!m || typeof m !== 'object') continue;
        const text = String(m.text ?? '').trim();
        if (!text) continue;
        try {
          insertExternalChatMessage(db, {
            source: body.source,
            conversation_id: conversationId,
            role: m.role || null,
            content: text,
            metadata: { url, title, ts: m.ts ?? null },
          });
          savedCount++;
        } catch { /* skip */ }
      }
      return c.json({ note: null, messages_saved: savedCount });
    }

    const { noteId, messagesSaved } = buildChatNote({
      source: body.source,
      url, title,
      conversation_id: conversationId,
      memo, messages,
      record_external: true,
    });
    const note = getNote(db, noteId)!;
    return c.json({ note, messages_saved: messagesSaved }, 201);
  });

  // ---- extension Notion ingest ---------------------------------------------

  function notionKindToBlockType(kind: string): NoteBlockType | null {
    switch (kind) {
      case 'heading_1': case 'heading_2': case 'heading_3':
      case 'text': case 'quote': case 'todo':
      case 'bullet_list': case 'numbered_list':
      case 'code': case 'divider':
        return kind;
      // Notion の /bookmark block は Memoria の bookmark_embed (URL カード) として保存
      case 'bookmark':
        return 'bookmark_embed';
      default: return null;
    }
  }

  // Notion ブロック列から note を組み立てる共通ヘルパー (extension の from-notion と
  // bookmark の reparse の両方から呼ばれる)。
  function buildNotionNote(opts: {
    url: string;
    title: string;
    page_id: string | null;
    memo: string;
    blocks: NotionExtractedBlock[];
  }): { noteId: string; blocksInserted: number } {
    const noteId = insertNote(db, {
      title: opts.title,
      kind: 'doc',
      source_kind: 'notion',
      source_ref: opts.page_id ?? opts.url,
      tags: ['notion'],
    });

    if (opts.memo.trim()) {
      insertBlock(db, noteId, { block_type: 'quote', text: opts.memo.trim() });
    }

    let inserted = 0;
    for (const b of opts.blocks) {
      if (!b || typeof b !== 'object') continue;
      const bb = b as Record<string, unknown>;
      const blockType = notionKindToBlockType(String(bb.kind ?? ''));
      if (!blockType) continue;
      const text = typeof bb.text === 'string' ? bb.text : '';
      const data: Record<string, unknown> = {};
      if (blockType === 'todo' && typeof bb.checked === 'boolean') data.checked = bb.checked;
      if ((blockType === 'bullet_list' || blockType === 'numbered_list') && typeof bb.indent === 'number') data.indent = bb.indent;
      if (blockType === 'code' && typeof bb.lang === 'string') data.lang = bb.lang;
      if (bb.kind === 'bookmark') {
        const bUrl = typeof bb.url === 'string' ? bb.url : '';
        if (!bUrl) continue;
        const existing = findBookmarkByUrl(db, bUrl);
        data.bookmark_id = existing ? existing.id : null;
        data.bookmark_url = bUrl;
        const bTitle = typeof bb.title === 'string' && bb.title ? bb.title
          : typeof bb.caption === 'string' && bb.caption ? bb.caption
          : bUrl;
        data.title = bTitle;
        if (typeof bb.caption === 'string' && bb.caption !== bTitle) data.summary = bb.caption;
        if (typeof bb.image === 'string') data.image = bb.image;
      }
      try {
        insertBlock(db, noteId, {
          block_type: blockType,
          text,
          data: Object.keys(data).length ? data : null,
        });
        inserted++;
      } catch { /* skip */ }
    }
    return { noteId, blocksInserted: inserted };
  }

  r.post('/api/notes/from-notion', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as {
      url?: unknown; page_id?: unknown; title?: unknown;
      blocks?: unknown; memo?: unknown; also_bookmark?: unknown;
    } | null;
    if (!body) return c.json({ error: 'body required' }, 400);
    const url = typeof body.url === 'string' ? body.url : '';
    const title = typeof body.title === 'string' ? body.title.slice(0, TITLE_MAX) : '';
    const pageId = typeof body.page_id === 'string' ? body.page_id : null;
    const memo = typeof body.memo === 'string' ? body.memo : '';
    const alsoBookmark = body.also_bookmark === true;
    if (!url || !title) return c.json({ error: 'url + title required' }, 400);
    const blocks = Array.isArray(body.blocks) ? body.blocks as NotionExtractedBlock[] : [];

    const { noteId, blocksInserted: inserted } = buildNotionNote({ url, title, page_id: pageId, memo, blocks });

    let createdBookmarkId: number | null = null;
    if (alsoBookmark && url) {
      // 既存 bookmark を探す → 無ければ最小限の bookmark 行を作る (HTML スナップショット
      // は extension 経由の通常 /api/bookmark で取得される。 ここでは url + title のみ
      // 登録し、 html_path は空 — HTML キャッシュは別途必要なら summary キューが処理)。
      const existing = findBookmarkByUrl(db, url);
      const bid = existing ? existing.id : insertBookmark(db, { url, title, htmlPath: '' });
      createdBookmarkId = bid;
      try {
        insertBlock(db, noteId, {
          block_type: 'bookmark_embed',
          text: '',
          data: {
            bookmark_id: bid,
            bookmark_url: url,
            title,
            summary: '',
          },
        });
      } catch { /* skip */ }
    }

    const note = getNote(db, noteId)!;
    return c.json({ note, blocks_inserted: inserted, bookmark_id: createdBookmarkId }, 201);
  });

  // ---- ad-hoc URL preview (Notion 風 /bookmark) ----------------------------
  //
  // editor の「URL を埋め込む」 から呼ばれる。 既に bookmark に登録済みなら
  // bookmark_id を返し、 そうでなければ OG metadata だけ返す。
  //
  // Plan B (= extension scrape 優先 + server fetch fallback):
  //   1. page_metadata 行 (extension が rendered DOM から書き込んだ og:*) があれば最優先
  //   2. bookmarks 行があれば title + summary を補完
  //   3. それでも足りなければ server-side で OG fetch (SPA 相手だと失敗しやすい)

  r.post('/api/notes/url-preview', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { url?: unknown } | null;
    const rawUrl = body && typeof body.url === 'string' ? body.url : '';
    if (!rawUrl) return c.json({ error: 'url required' }, 400);

    const existing = findBookmarkByUrl(db, rawUrl);
    const cached = getPageMetadata(db, rawUrl);

    // Step 1: extension scrape cache が題名 / 画像どれかを持っていれば、 server fetch せずに返す
    const hasUsefulCache = cached && (
      (cached.og_title && cached.og_title.trim()) ||
      (cached.og_image && cached.og_image.trim()) ||
      (cached.og_description && cached.og_description.trim())
    );
    if (hasUsefulCache && cached) {
      return c.json({
        url: rawUrl,
        bookmark_id: existing ? existing.id : null,
        title: cached.og_title || cached.title || existing?.title || rawUrl,
        description: cached.og_description || cached.meta_description || existing?.summary || '',
        image: cached.og_image || null,
        site_name: hostnameOf(rawUrl),
        ok: true,
        source: 'extension-scrape' as const,
      });
    }

    // Step 2: bookmark 行があれば title + summary を返す (画像なしの軽量カード)
    if (existing) {
      return c.json({
        url: rawUrl,
        bookmark_id: existing.id,
        title: existing.title || rawUrl,
        description: existing.summary || '',
        image: null,
        site_name: hostnameOf(rawUrl),
        ok: true,
        source: 'bookmark-row' as const,
      });
    }

    // Step 3: 最終 fallback — server-side OG fetch (SPA 相手だと SSR shell しか取れない)
    const preview = await fetchUrlPreview(rawUrl);
    return c.json({
      url: preview.url || rawUrl,
      bookmark_id: null,
      title: preview.title || rawUrl,
      description: preview.description,
      image: preview.image,
      site_name: preview.site_name,
      ok: preview.ok,
      error: preview.error,
      source: 'server-fetch' as const,
    });
  });

  // ---- bookmark の保存済 HTML を再パースして note 化 --------------------
  //
  // 拡張は bookmark 保存時に rendered HTML を残す (html_path)。
  // パーサが強化された後でも、 過去のスナップショットに対して再抽出を
  // 走らせて note を作り直せるようにするための entry。
  //
  // POST /api/bookmarks/:id/reparse
  //   body: { kind?: 'chat' | 'notion' (省略時は URL から auto-detect),
  //           chat_source?: 'chatgpt' | 'claude' | 'gemini' (chat 時),
  //           memo?: string }
  r.post('/api/bookmarks/:id/reparse', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const b = getBookmark(db, id);
    if (!b) return c.json({ error: 'bookmark not found' }, 404);
    if (!b.html_path) return c.json({ error: 'no html snapshot saved for this bookmark' }, 404);

    const htmlPath = join(htmlDir, b.html_path);
    if (!existsSync(htmlPath)) return c.json({ error: 'html file missing on disk' }, 404);

    let html: string;
    try { html = readFileSync(htmlPath, 'utf8'); }
    catch (e) { return c.json({ error: `read html failed: ${e instanceof Error ? e.message : String(e)}` }, 500); }

    const body = await c.req.json().catch(() => null) as {
      kind?: unknown; chat_source?: unknown; memo?: unknown;
    } | null;
    const explicitKind = body && (body.kind === 'chat' || body.kind === 'notion')
      ? (body.kind as 'chat' | 'notion') : undefined;
    const chatSource = body && isValidChatSource(body.chat_source) ? body.chat_source : undefined;
    const memo = body && typeof body.memo === 'string' ? body.memo : '';

    const result = reparseHtml(b.url, html, { kind: explicitKind, chat_source: chatSource });
    if (!result) {
      return c.json({
        error: 'auto-detect failed — bookmark URL is not a recognized chat / notion page',
        hint: 'pass kind="chat" + chat_source="chatgpt|claude|gemini" or kind="notion" explicitly',
      }, 400);
    }

    if (result.kind === 'chat') {
      if (result.messages.length === 0) {
        return c.json({
          error: 'no chat messages extracted from saved HTML',
          hint: 'extension scrapes JS-rendered DOM; if the saved HTML is the raw shell, no messages can be recovered',
          kind: 'chat', source: result.source,
        }, 422);
      }
      const { noteId, messagesSaved } = buildChatNote({
        source: result.source,
        url: b.url,
        title: result.title || b.title,
        conversation_id: null,
        memo,
        messages: result.messages,
        // 再パース時は external_chat への二重保存をしない (extension の初回保存時のみ書く)
        record_external: false,
      });
      const note = getNote(db, noteId)!;
      return c.json({
        ok: true, kind: 'chat', source: result.source,
        note, messages_saved: messagesSaved, messages_count: result.messages.length,
      }, 201);
    }

    // notion
    if (!result.title) {
      return c.json({ error: 'no notion title detected — saved HTML may not be a notion page' }, 422);
    }
    if (result.blocks.length === 0) {
      return c.json({
        error: 'no notion blocks extracted from saved HTML',
        kind: 'notion',
      }, 422);
    }
    const { noteId, blocksInserted } = buildNotionNote({
      url: b.url,
      title: result.title,
      page_id: result.page_id,
      memo,
      blocks: result.blocks,
    });
    const note = getNote(db, noteId)!;
    return c.json({
      ok: true, kind: 'notion',
      note, blocks_inserted: blocksInserted, page_id: result.page_id,
    }, 201);
  });

  // ---- extension dispatch rules --------------------------------------------

  r.get('/api/extension/rules', (c: Context) => {
    return c.json(getExtensionRules(db));
  });

  r.put('/api/extension/rules', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as ExtensionRulesUpdateRequest;
    const cur = getExtensionRules(db);
    const next: ExtensionRules = {
      chat_domains: Array.isArray(body.chat_domains)
        ? body.chat_domains.filter((d): d is ExtensionChatDomain =>
            !!d && typeof d.host === 'string' && (d.source === 'chatgpt' || d.source === 'claude' || d.source === 'gemini'))
        : cur.chat_domains,
      impl_rules: Array.isArray(body.impl_rules)
        ? body.impl_rules.filter((d): d is ExtensionImplRule =>
            !!d && typeof d.host_pattern === 'string' && Array.isArray(d.keywords))
        : cur.impl_rules,
      shopping_domains: Array.isArray(body.shopping_domains)
        ? body.shopping_domains.filter((d): d is ExtensionShoppingDomain =>
            !!d && typeof d.host === 'string')
        : cur.shopping_domains,
      notion_domains: Array.isArray((body as { notion_domains?: unknown }).notion_domains)
        ? ((body as { notion_domains: unknown[] }).notion_domains).filter((d): d is ExtensionNotionDomain =>
            !!d && typeof (d as { host?: unknown }).host === 'string')
        : cur.notion_domains,
    };
    setExtensionRules(db, next);
    return c.json(next);
  });

  return r;
}
