// /api/notes* — markdown ライク WYSIWYG ノート (UUID 管理) + bookmark base + per-user comment sets
// Spec: spec/api/note.md / spec/feature/note.md / spec/feature/extension.md

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  listNotes, getNote, listNoteBlocks, insertNote, updateNote, deleteNote,
  insertBlock, updateBlock, deleteBlock, reorderBlocks, getBlockByUuid,
  insertExternalChatMessage, getBookmark,
  getOrCreateCommentSet, listCommentSets, getCommentSet, deleteCommentSet,
  listComments, insertComment, updateComment, deleteComment,
  getExtensionRules, setExtensionRules,
} from '../db.js';
import type {
  ExtensionRules, ExtensionChatDomain, ExtensionImplRule, ExtensionShoppingDomain,
} from '../db.js';
import type { NoteRow, NoteBlockRow, NoteBlockType, NoteKind } from '../db/types/note.js';
import { NOTE_BLOCK_TYPES } from '../db/types/note.js';
import type {
  NoteSummary, NoteWithBlocks, BlockCreateRequest,
  ChatExtractedMessage, ChatExtractionSource,
  ExtensionRulesUpdateRequest,
  CommentSetWithComments,
} from '../api/types/note.js';

type Db = BetterSqlite3.Database;

const TITLE_MAX = 200;
const TEXT_MAX = 64 * 1024;
const DATA_MAX = 32 * 1024;
const TAG_MAX = 32;
const TAGS_MAX_COUNT = 16;
const COMMENT_TEXT_MAX = 16 * 1024;

export interface NoteRouterDeps {
  db: Db;
}

export function makeNoteRouter(deps: NoteRouterDeps): Hono {
  const { db } = deps;
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
    if (!getNote(db, id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof body.title === 'string') patch.title = body.title.slice(0, TITLE_MAX);
    if (typeof body.kind === 'string' && body.kind.trim()) patch.kind = body.kind.trim();
    if (Array.isArray(body.tags)) patch.tags = sanitizeTags(body.tags);
    if (typeof body.bookmark_id === 'number' || body.bookmark_id === null) patch.bookmark_id = body.bookmark_id;
    if (typeof body.bookmark_url === 'string' || body.bookmark_url === null) patch.bookmark_url = body.bookmark_url;
    if (typeof body.source_kind === 'string' || body.source_kind === null) patch.source_kind = body.source_kind;
    if (typeof body.source_ref === 'string' || body.source_ref === null) patch.source_ref = body.source_ref;
    updateNote(db, id, patch);
    return c.json(getNote(db, id));
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
    try {
      const block = insertBlock(db, noteId, {
        block_type: body.block_type,
        text: typeof body.text === 'string' ? body.text : '',
        data: body.data ?? null,
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

    if (!alsoCreateNote) {
      return c.json({ note: null, messages_saved: savedCount });
    }

    const noteTitle = title || `${body.source} chat (${new Date().toISOString().slice(0, 10)})`;
    const noteId = insertNote(db, {
      title: noteTitle,
      kind: 'chat',
      source_kind: 'chat',
      source_ref: conversationId || url,
      tags: [body.source],
    });

    const headerLines = [
      `**Source**: ${body.source}`,
      url ? `**URL**: <${url}>` : '',
      `**Imported**: ${new Date().toISOString()}`,
      memo ? `\n${memo}` : '',
    ].filter(Boolean).join('\n');
    insertBlock(db, noteId, { block_type: 'quote', text: headerLines });

    for (const m of messages) {
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

    const note = getNote(db, noteId)!;
    return c.json({ note, messages_saved: savedCount }, 201);
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
    };
    setExtensionRules(db, next);
    return c.json(next);
  });

  return r;
}
