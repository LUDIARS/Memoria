// /api/dictionary*, /api/stopwords*, /api/wordcloud*
// Spec: spec/interface/dict.md

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  listDictionaryEntries, getDictionaryEntry, findDictionaryEntryByTerm,
  insertDictionaryEntry, updateDictionaryEntry, deleteDictionaryEntry,
  addDictionaryLink, removeDictionaryLink,
  listUserStopwords, addUserStopword, removeUserStopword,
  insertWordCloud, setWordCloudResult, getWordCloud, listWordClouds,
  listBookmarks, getDigSession, getBookmark, getBookmarkWordCloud,
} from '../db.js';
import type { WordCloudParsed } from '../db.js';
import { htmlToText } from '../claude.js';
import { validateWordRelevance } from '../wordcloud.js';

type Db = BetterSqlite3.Database;

const BOOKMARK_DOC_LIMIT = 80;
const DIG_DOC_LIMIT = 30;
const SINGLE_BOOKMARK_TEXT_LIMIT = 12000;

interface DigSourceJson {
  url?: string;
  title?: string;
  snippet?: string;
  topics?: string[];
}

interface DigResultJson {
  summary?: string;
  sources?: DigSourceJson[];
}

interface WordCloudWord {
  word?: unknown;
  weight?: unknown;
  sources?: unknown;
  kept?: unknown;
  reason?: string;
}

interface WordCloudResultJson {
  summary?: string;
  words?: WordCloudWord[];
  merged_from?: { id: number; label?: string }[];
  base_summary?: string;
}

export interface DictRouterDeps {
  db: Db;
  htmlDir: string;
  enqueueCloud: (id: number, args: { docs: string; label: string }) => void;
}

export function makeDictRouter(deps: DictRouterDeps): Hono {
  const { db, htmlDir, enqueueCloud } = deps;
  const r = new Hono();

  // ---- word clouds ---------------------------------------------------------

  function buildBookmarksDocs({ category, limit = BOOKMARK_DOC_LIMIT }: { category?: string | null; limit?: number }): string {
    const items = listBookmarks(db, { category: category ?? undefined }).slice(0, limit);
    return items.map((b, i) => {
      const cats = (b.categories ?? []).join(', ');
      const summary = (b.summary ?? '').slice(0, 800);
      return `[Doc ${i + 1}] ${b.title}\nURL: ${b.url}\nCategories: ${cats}\nSummary: ${summary}`;
    }).join('\n\n');
  }

  function buildDigDocs(session: { result?: unknown }): string {
    const res = (session.result ?? {}) as DigResultJson;
    const sources = (res.sources ?? []).slice(0, DIG_DOC_LIMIT);
    if (sources.length === 0) return '';
    const head = res.summary ? `OVERVIEW: ${res.summary}\n\n` : '';
    return head + sources.map((s, i) => {
      const topics = (s.topics ?? []).join(', ');
      return `[Doc ${i + 1}] ${s.title}\nURL: ${s.url}\nTopics: ${topics}\nSnippet: ${s.snippet}`;
    }).join('\n\n');
  }

  function buildBookmarkDoc(b: { title: string; url: string; categories?: string[] | null; summary?: string | null; html_path: string }): string {
    let bodyText = '';
    try {
      const html = readFileSync(join(htmlDir, b.html_path), 'utf8');
      bodyText = htmlToText(html).slice(0, SINGLE_BOOKMARK_TEXT_LIMIT);
    } catch { /* ignore */ }
    const cats = (b.categories ?? []).join(', ');
    return `Title: ${b.title}\nURL: ${b.url}\nCategories: ${cats}\nSummary: ${b.summary ?? ''}\n\nBody:\n${bodyText}`;
  }

  r.post('/api/wordcloud', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as
      | { origin?: unknown; parentCloudId?: unknown; parentWord?: unknown; category?: unknown; digId?: unknown }
      | null;
    if (!body) return c.json({ error: 'body required' }, 400);
    const origin = body.origin;
    const parentCloudId = (typeof body.parentCloudId === 'number') ? body.parentCloudId : null;
    const parentWord = typeof body.parentWord === 'string' ? body.parentWord : null;

    let label: string;
    let docs: string;
    let originDigId: number | null = null;

    if (origin === 'bookmarks') {
      const cat = typeof body.category === 'string' ? body.category : null;
      const items = listBookmarks(db, { category: cat ?? undefined });
      if (items.length === 0) return c.json({ error: 'no bookmarks' }, 400);
      label = cat ? `bookmarks:${cat}` : 'all bookmarks';
      docs = buildBookmarksDocs({ category: cat });
    } else if (origin === 'dig') {
      const digId = Number(body.digId);
      const ses = getDigSession(db, digId);
      if (!ses) return c.json({ error: 'dig session not found' }, 404);
      if (ses.status !== 'done') return c.json({ error: `dig status: ${ses.status}` }, 400);
      label = ses.query;
      originDigId = digId;
      docs = buildDigDocs(ses);
      if (!docs) return c.json({ error: 'dig has no sources' }, 400);
    } else {
      return c.json({ error: 'origin must be bookmarks or dig' }, 400);
    }

    const id = insertWordCloud(db, {
      origin: origin as 'bookmarks' | 'dig',
      originDigId,
      parentCloudId,
      parentWord,
      label,
    });
    enqueueCloud(id, { docs, label });
    return c.json({ id, queued: true });
  });

  r.get('/api/wordcloud', (c: Context) => {
    return c.json({ items: listWordClouds(db) });
  });

  r.get('/api/wordcloud/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    const w = getWordCloud(db, id);
    if (!w) return c.json({ error: 'not found' }, 404);
    return c.json({ ...w, related_pages: buildRelatedPages(w) });
  });

  function buildRelatedPages(wc: WordCloudParsed | null, depth = 0): { url: string; title: string; snippet: string; kind: string }[] {
    if (!wc || depth > 2) return [];
    if (wc.origin === 'dig' && wc.origin_dig_id) {
      const dig = getDigSession(db, wc.origin_dig_id);
      if (!dig) return [];
      const res = (dig.result ?? {}) as DigResultJson;
      return (res.sources ?? []).map((s) => ({
        url: s.url ?? '', title: s.title || s.url || '',
        snippet: (s.snippet ?? '').slice(0, 200), kind: 'dig-source',
      }));
    }
    if (wc.origin === 'bookmark' && wc.origin_bookmark_id) {
      const b = getBookmark(db, wc.origin_bookmark_id);
      return b ? [{ url: b.url, title: b.title, snippet: (b.summary ?? '').slice(0, 200), kind: 'bookmark' }] : [];
    }
    if (wc.origin === 'bookmarks') {
      return listBookmarks(db).slice(0, 16).map((b) => ({
        url: b.url, title: b.title, snippet: (b.summary ?? '').slice(0, 200), kind: 'bookmark',
      }));
    }
    if (wc.origin === 'merged') {
      const out: { url: string; title: string; snippet: string; kind: string }[] = [];
      const seen = new Set<string>();
      const result = (wc.result ?? {}) as WordCloudResultJson;
      for (const m of (result.merged_from ?? [])) {
        const child = getWordCloud(db, m.id);
        for (const p of buildRelatedPages(child, depth + 1)) {
          if (seen.has(p.url)) continue;
          seen.add(p.url);
          out.push(p);
        }
      }
      return out.slice(0, 30);
    }
    return [];
  }

  r.get('/api/wordcloud/:id/graph', (c: Context) => {
    const id = Number(c.req.param('id'));
    const radius = Math.min(3, Math.max(1, Number(c.req.query('radius')) || 3));
    if (!getWordCloud(db, id)) return c.json({ error: 'not found' }, 404);

    // BFS over parent_cloud_id (up) and child clouds (down).
    const seen = new Map<number, number>(); // id → depth from current
    const queue: { id: number; depth: number }[] = [{ id, depth: 0 }];
    seen.set(id, 0);
    while (queue.length > 0) {
      const head = queue.shift();
      if (!head) break;
      const { id: nid, depth } = head;
      if (depth >= radius) continue;
      const cur = db.prepare(`SELECT parent_cloud_id FROM word_clouds WHERE id = ?`).get(nid) as { parent_cloud_id?: number | null } | undefined;
      if (cur?.parent_cloud_id && !seen.has(cur.parent_cloud_id)) {
        seen.set(cur.parent_cloud_id, depth + 1);
        queue.push({ id: cur.parent_cloud_id, depth: depth + 1 });
      }
      const children = db.prepare(`
        SELECT id FROM word_clouds WHERE parent_cloud_id = ? AND status = 'done'
      `).all(nid) as { id: number }[];
      for (const ch of children) {
        if (!seen.has(ch.id)) {
          seen.set(ch.id, depth + 1);
          queue.push({ id: ch.id, depth: depth + 1 });
        }
      }
    }

    // Count truncated branches (clouds at depth=radius that still have un-fetched
    // children — UI uses this to draw a "..." stub).
    const truncated = new Map<number, number>(); // id → truncated_count
    for (const [nid, depth] of seen.entries()) {
      if (depth !== radius) continue;
      const childCount = (db.prepare(`
        SELECT COUNT(*) AS n FROM word_clouds WHERE parent_cloud_id = ? AND status = 'done'
      `).get(nid) as { n?: number } | undefined)?.n ?? 0;
      if (childCount > 0) truncated.set(nid, childCount);
    }

    const nodes = [...seen.keys()].map((nid) => {
      const wc = getWordCloud(db, nid);
      const res = (wc?.result ?? {}) as WordCloudResultJson;
      const topWords = (res.words ?? []).filter((w) => w.kept)
        .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
        .slice(0, 5)
        .map((w) => ({ word: w.word, weight: w.weight }));
      const totalWeight = topWords.reduce((s, w) => s + (Number(w.weight) || 0), 0);
      return {
        id: nid,
        label: wc?.label || `cloud#${nid}`,
        parent_cloud_id: wc?.parent_cloud_id ?? null,
        parent_word: wc?.parent_word ?? null,
        origin: wc?.origin ?? '',
        depth: seen.get(nid),
        total_weight: totalWeight,
        top_words: topWords,
        summary: (res.summary ?? '').slice(0, 200),
        truncated_children: truncated.get(nid) ?? 0,
      };
    });
    const idsInGraph = new Set(seen.keys());
    const edges = nodes
      .filter((n) => n.parent_cloud_id != null && idsInGraph.has(n.parent_cloud_id))
      .map((n) => ({ from: n.parent_cloud_id, to: n.id, label: n.parent_word ?? '' }));

    return c.json({ current: id, radius, nodes, edges });
  });

  r.get('/api/wordcloud/:id/siblings', (c: Context) => {
    const id = Number(c.req.param('id'));
    const cur = getWordCloud(db, id);
    if (!cur) return c.json({ error: 'not found' }, 404);
    if (!cur.parent_cloud_id) return c.json({ items: [] });
    const rows = db.prepare(`
      SELECT id, label, status, parent_word, created_at
      FROM word_clouds
      WHERE parent_cloud_id = ? AND id != ? AND status = 'done'
      ORDER BY id DESC
    `).all(cur.parent_cloud_id, id);
    return c.json({ items: rows });
  });

  r.post('/api/wordcloud/merge', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { cloudIds?: unknown; label?: unknown } | null;
    const cloudIds = Array.isArray(body?.cloudIds)
      ? body.cloudIds.map(Number).filter(Number.isFinite)
      : [];
    if (cloudIds.length < 2) return c.json({ error: 'cloudIds[] (>=2) required' }, 400);
    const clouds = cloudIds.map((cid) => getWordCloud(db, cid)).filter((x): x is WordCloudParsed => !!x);
    const done = clouds.filter((cl) => cl.status === 'done' && cl.result);
    if (done.length < 2) return c.json({ error: 'need at least 2 completed clouds' }, 400);

    const merged = mergeWordCloudResults(done);
    const label = (typeof body?.label === 'string' && body.label.trim())
      ? body.label.trim().slice(0, 200)
      : `merged: ${done.map((d) => d.label).join(' + ').slice(0, 160)}`;
    const id = insertWordCloud(db, {
      origin: 'merged',
      originDigId: null,
      parentCloudId: done[0].parent_cloud_id ?? null,
      parentWord: cloudIds.join(','),
      label,
    });
    setWordCloudResult(db, id, { status: 'done', result: merged });
    return c.json({ id });
  });

  r.post('/api/wordcloud/validate-word', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { word?: unknown; context?: unknown } | null;
    const word = body?.word;
    const context = body?.context;
    if (typeof word !== 'string' || typeof context !== 'string') return c.json({ error: 'word and context required' }, 400);
    try {
      const r2 = await validateWordRelevance({ word, context });
      return c.json(r2);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 500);
    }
  });

  // Per-bookmark word cloud (default: not generated; on-demand).
  r.post('/api/bookmarks/:id/wordcloud', async (c: Context) => {
    const id = Number(c.req.param('id'));
    const b = getBookmark(db, id);
    if (!b) return c.json({ error: 'not found' }, 404);
    const docs = buildBookmarkDoc(b);
    const cloudId = insertWordCloud(db, {
      origin: 'bookmark',
      originDigId: null,
      parentCloudId: null,
      parentWord: null,
      label: b.title || b.url,
    });
    // Stamp origin_bookmark_id (insertWordCloud schema doesn't accept it directly).
    db.prepare(`UPDATE word_clouds SET origin_bookmark_id = ? WHERE id = ?`).run(id, cloudId);
    enqueueCloud(cloudId, { docs, label: b.title || b.url });
    return c.json({ id: cloudId, queued: true });
  });

  r.get('/api/bookmarks/:id/wordcloud', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!getBookmark(db, id)) return c.json({ error: 'not found' }, 404);
    const cloud = getBookmarkWordCloud(db, id);
    return c.json({ cloud });
  });

  // ---- dictionary -----------------------------------------------------------

  r.get('/api/dictionary', (c: Context) => {
    const search = c.req.query('q')?.trim() || undefined;
    return c.json({ items: listDictionaryEntries(db, { search }) });
  });

  r.get('/api/dictionary/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    const e = getDictionaryEntry(db, id);
    if (!e) return c.json({ error: 'not found' }, 404);
    return c.json(e);
  });

  // ---- user stopwords (グラフ / ワードクラウド除外語) ----------------------
  r.get('/api/stopwords', (c: Context) => {
    return c.json({ items: listUserStopwords(db) });
  });
  r.post('/api/stopwords', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { word?: unknown } | null;
    const word = (body?.word ?? '').toString().trim();
    if (!word) return c.json({ error: 'word required' }, 400);
    addUserStopword(db, word);
    return c.json({ ok: true, word });
  });
  r.delete('/api/stopwords/:word', (c: Context) => {
    const word = decodeURIComponent(c.req.param('word') ?? '');
    const removed = removeUserStopword(db, word);
    return c.json({ ok: removed });
  });

  r.post('/api/dictionary', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as
      | { term?: unknown; definition?: unknown; notes?: unknown }
      | null;
    const term = (body?.term ?? '').toString().trim();
    if (!term) return c.json({ error: 'term required' }, 400);
    const existing = findDictionaryEntryByTerm(db, term);
    if (existing) {
      // Idempotent: update if any new fields supplied, otherwise return existing.
      const patch: { definition?: string; notes?: string } = {};
      if (typeof body?.definition === 'string') patch.definition = body.definition;
      if (typeof body?.notes === 'string') patch.notes = body.notes;
      if (Object.keys(patch).length > 0) updateDictionaryEntry(db, existing.id, patch);
      return c.json({ id: existing.id, existed: true });
    }
    const id = insertDictionaryEntry(db, {
      term,
      definition: typeof body?.definition === 'string' ? body.definition : null,
      notes: typeof body?.notes === 'string' ? body.notes : null,
    });
    return c.json({ id, existed: false });
  });

  r.patch('/api/dictionary/:id', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!getDictionaryEntry(db, id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as { definition?: string; notes?: string; term?: string };
    updateDictionaryEntry(db, id, body);
    return c.json(getDictionaryEntry(db, id));
  });

  r.delete('/api/dictionary/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    deleteDictionaryEntry(db, id);
    return c.json({ ok: true });
  });

  const VALID_DICT_SOURCE_KINDS = new Set(['cloud', 'dig', 'bookmark']);

  r.post('/api/dictionary/:id/links', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!getDictionaryEntry(db, id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => null) as { source_kind?: unknown; source_id?: unknown } | null;
    const sourceKind = body?.source_kind;
    const sourceId = Number(body?.source_id);
    if (typeof sourceKind !== 'string' || !VALID_DICT_SOURCE_KINDS.has(sourceKind)) return c.json({ error: 'source_kind must be cloud|dig|bookmark' }, 400);
    if (!Number.isFinite(sourceId)) return c.json({ error: 'source_id required' }, 400);
    addDictionaryLink(db, { entryId: id, sourceKind: sourceKind as 'cloud' | 'dig' | 'bookmark', sourceId });
    return c.json({ ok: true });
  });

  r.delete('/api/dictionary/:id/links', async (c: Context) => {
    const id = Number(c.req.param('id'));
    const sourceKind = c.req.query('source_kind');
    const sourceId = Number(c.req.query('source_id'));
    if (typeof sourceKind !== 'string' || !VALID_DICT_SOURCE_KINDS.has(sourceKind)) return c.json({ error: 'source_kind required' }, 400);
    if (!Number.isFinite(sourceId)) return c.json({ error: 'source_id required' }, 400);
    removeDictionaryLink(db, { entryId: id, sourceKind: sourceKind as 'cloud' | 'dig' | 'bookmark', sourceId });
    return c.json({ ok: true });
  });

  /** Convenience: upsert a term + add a source link in one call. */
  r.post('/api/dictionary/upsert-from-source', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as
      | { term?: unknown; source_kind?: unknown; source_id?: unknown; definition?: unknown; notes?: unknown }
      | null;
    const term = (body?.term ?? '').toString().trim();
    const sourceKind = body?.source_kind;
    const sourceId = Number(body?.source_id);
    if (!term) return c.json({ error: 'term required' }, 400);
    if (typeof sourceKind !== 'string' || !VALID_DICT_SOURCE_KINDS.has(sourceKind)) return c.json({ error: 'source_kind required' }, 400);
    if (!Number.isFinite(sourceId)) return c.json({ error: 'source_id required' }, 400);

    const existing = findDictionaryEntryByTerm(db, term);
    let entryId: number;
    let existed = false;
    if (existing) {
      entryId = existing.id;
      existed = true;
      if (typeof body?.definition === 'string' || typeof body?.notes === 'string') {
        updateDictionaryEntry(db, entryId, {
          definition: typeof body?.definition === 'string' ? body.definition : undefined,
          notes: typeof body?.notes === 'string' ? body.notes : undefined,
        });
      }
    } else {
      entryId = insertDictionaryEntry(db, {
        term,
        definition: typeof body?.definition === 'string' ? body.definition : null,
        notes: typeof body?.notes === 'string' ? body.notes : null,
      });
    }
    addDictionaryLink(db, { entryId, sourceKind: sourceKind as 'cloud' | 'dig' | 'bookmark', sourceId });
    return c.json({ id: entryId, existed });
  });

  return r;
}

function mergeWordCloudResults(clouds: WordCloudParsed[]): {
  summary: string;
  words: { word: unknown; weight: number; sources: number; kept: boolean; reason: string }[];
  merged_from: { id: number; label: string }[];
  base_summary: string;
} {
  interface Aggregate { word: unknown; weightSum: number; sources: number; kept: boolean; count: number; reasons: string[] }
  const map = new Map<string, Aggregate>(); // word_lower → aggregate
  let firstSummary = '';
  for (const cl of clouds) {
    const r = (cl.result ?? {}) as WordCloudResultJson;
    if (!firstSummary && r.summary) firstSummary = r.summary;
    for (const w of (r.words ?? [])) {
      const key = String(w.word ?? '').toLowerCase().trim();
      if (!key) continue;
      const cur = map.get(key) ?? {
        word: w.word, weightSum: 0, sources: 0, kept: false, count: 0, reasons: [] as string[],
      };
      cur.weightSum += Number(w.weight) || 0;
      cur.sources += Number(w.sources) || 1;
      cur.kept = cur.kept || !!w.kept;
      cur.count += 1;
      if (!w.kept && w.reason) cur.reasons.push(w.reason);
      map.set(key, cur);
    }
  }
  // Bonus: words appearing in more clouds get a boost.
  const words = [...map.values()].map((w) => ({
    word: w.word,
    weight: Math.min(100, Math.round(w.weightSum + (w.count - 1) * 8)),
    sources: w.sources,
    kept: w.kept,
    reason: w.kept ? '' : (w.reasons[0] || ''),
  }));
  words.sort((a, b) => b.weight - a.weight);
  const labelList = clouds.map((cl) => `「${cl.label}」`).join(' + ');
  return {
    summary: clouds.length === 2
      ? `${labelList} の合体クラウド (${words.length} 語)`
      : `${clouds.length} 件の関連クラウドを統合 (${words.length} 語)`,
    words: words.slice(0, 80),
    merged_from: clouds.map((cl) => ({ id: cl.id, label: cl.label })),
    base_summary: firstSummary,
  };
}

