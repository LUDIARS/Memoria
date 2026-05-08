// /api/notes* — markdown ライク WYSIWYG ノート + 拡張からのチャット取り込み
// Spec: spec/api/note.md / spec/feature/note.md / spec/feature/extension.md

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  listNotes, getNote, listNoteBlocks, insertNote, updateNote, deleteNote,
  insertBlock, updateBlock, deleteBlock, reorderBlocks,
  insertExternalChatMessage,
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
} from '../api/types/note.js';

type Db = BetterSqlite3.Database;

const TITLE_MAX = 200;
const TEXT_MAX = 64 * 1024;
const DATA_MAX = 32 * 1024;
const TAG_MAX = 32;
const TAGS_MAX_COUNT = 16;

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
    const limit = Math.min(Number(c.req.query('limit') || 50), 200);
    const offset = Math.max(0, Number(c.req.query('offset') || 0));
    const { items, total } = listNotes(db, {
      q, kind: kindQ || null, limit, offset,
    });
    return c.json({
      items: items.map(rowToSummary),
      total,
    });
  });

  r.get('/api/notes/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    const note = getNote(db, id);
    if (!note) return c.json({ error: 'not found' }, 404);
    const blocks = listNoteBlocks(db, id);
    return c.json(rowToWithBlocks(note, blocks));
  });

  r.post('/api/notes', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as {
      title?: unknown; kind?: unknown; tags?: unknown;
      source_kind?: unknown; source_ref?: unknown;
      initial_blocks?: unknown;
    };
    const title = String(body.title ?? '').trim().slice(0, TITLE_MAX);
    const kind = (typeof body.kind === 'string' && body.kind.trim()) ? body.kind.trim() : 'doc';
    const tags = sanitizeTags(body.tags);
    const id = insertNote(db, {
      title,
      kind,
      tags,
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
        } catch { /* skip invalid */ }
      }
    }

    const note = getNote(db, id)!;
    return c.json(note, 201);
  });

  r.patch('/api/notes/:id', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!getNote(db, id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof body.title === 'string') patch.title = body.title.slice(0, TITLE_MAX);
    if (typeof body.kind === 'string' && body.kind.trim()) patch.kind = body.kind.trim();
    if (Array.isArray(body.tags)) patch.tags = sanitizeTags(body.tags);
    if (typeof body.source_kind === 'string' || body.source_kind === null) patch.source_kind = body.source_kind;
    if (typeof body.source_ref === 'string' || body.source_ref === null) patch.source_ref = body.source_ref;
    updateNote(db, id, patch);
    return c.json(getNote(db, id));
  });

  r.delete('/api/notes/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!getNote(db, id)) return c.json({ error: 'not found' }, 404);
    deleteNote(db, id);
    return c.json({ ok: true });
  });

  // ---- blocks ---------------------------------------------------------------

  r.post('/api/notes/:id/blocks', async (c: Context) => {
    const noteId = Number(c.req.param('id'));
    if (!getNote(db, noteId)) return c.json({ error: 'note not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as BlockCreateRequest & { after_block_id?: unknown };
    const err = validateBlockPayload(body);
    if (err) return c.json({ error: err }, 400);
    try {
      const blockId = insertBlock(db, noteId, {
        block_type: body.block_type,
        text: typeof body.text === 'string' ? body.text : '',
        data: body.data ?? null,
        after_block_id: typeof body.after_block_id === 'number' ? body.after_block_id : null,
      });
      const block = listNoteBlocks(db, noteId).find((b) => b.id === blockId);
      return c.json(block, 201);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  r.patch('/api/notes/:id/blocks/:blockId', async (c: Context) => {
    const noteId = Number(c.req.param('id'));
    const blockId = Number(c.req.param('blockId'));
    if (!getNote(db, noteId)) return c.json({ error: 'note not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const err = validateBlockPayload(body as unknown as BlockCreateRequest, true);
    if (err) return c.json({ error: err }, 400);
    try {
      const ok = updateBlock(db, noteId, blockId, body);
      if (!ok) return c.json({ error: 'block not found' }, 404);
      const block = listNoteBlocks(db, noteId).find((b) => b.id === blockId);
      return c.json(block);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  r.delete('/api/notes/:id/blocks/:blockId', (c: Context) => {
    const noteId = Number(c.req.param('id'));
    const blockId = Number(c.req.param('blockId'));
    if (!getNote(db, noteId)) return c.json({ error: 'note not found' }, 404);
    const ok = deleteBlock(db, noteId, blockId);
    if (!ok) return c.json({ error: 'block not found' }, 404);
    return c.json({ ok: true });
  });

  r.post('/api/notes/:id/blocks/reorder', async (c: Context) => {
    const noteId = Number(c.req.param('id'));
    if (!getNote(db, noteId)) return c.json({ error: 'note not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as { order?: unknown };
    if (!Array.isArray(body.order) || !body.order.every((n) => Number.isFinite(n))) {
      return c.json({ error: 'order: number[] required' }, 400);
    }
    try {
      const blocks = reorderBlocks(db, noteId, body.order.map(Number));
      return c.json({ ok: true, blocks });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
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
    const alsoCreateNote = body.also_create_note !== false; // default true

    // 1) external_chat_messages に 1 行ずつ insert
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

    // 2) Note を作成 — 1 メッセージ = 1 ブロック
    const noteTitle = title || `${body.source} chat (${new Date().toISOString().slice(0, 10)})`;
    const noteId = insertNote(db, {
      title: noteTitle,
      kind: 'chat',
      source_kind: 'chat',
      source_ref: conversationId || url,
      tags: [body.source],
    });

    // ヘッダブロック (URL + 取り込み日時 + memo)
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
      // 役割を heading_3 として 1 ブロック、 本文を text として 1 ブロック
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
