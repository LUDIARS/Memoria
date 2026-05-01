// Wordcloud router (mounted at `/api/wordcloud`).
//
// The per-bookmark wordcloud endpoints (POST/GET `/api/bookmarks/:id/wordcloud`)
// live in routes/bookmarks.js because they hang off the bookmark resource.
// `mergeWordCloudResults` and `buildRelatedPages` stay private to this router.
import { Hono } from 'hono';

const BOOKMARK_DOC_LIMIT = 80;
const DIG_DOC_LIMIT = 30;

function buildBookmarksDocs({ db, listBookmarks, category, limit = BOOKMARK_DOC_LIMIT }) {
  const items = listBookmarks(db, { category }).slice(0, limit);
  return items.map((b, i) => {
    const cats = (b.categories || []).join(', ');
    const summary = (b.summary || '').slice(0, 800);
    return `[Doc ${i + 1}] ${b.title}\nURL: ${b.url}\nCategories: ${cats}\nSummary: ${summary}`;
  }).join('\n\n');
}

function buildDigDocs(session) {
  const r = session.result || {};
  const sources = (r.sources || []).slice(0, DIG_DOC_LIMIT);
  if (sources.length === 0) return '';
  const head = r.summary ? `OVERVIEW: ${r.summary}\n\n` : '';
  return head + sources.map((s, i) => {
    const topics = (s.topics || []).join(', ');
    return `[Doc ${i + 1}] ${s.title}\nURL: ${s.url}\nTopics: ${topics}\nSnippet: ${s.snippet}`;
  }).join('\n\n');
}

function mergeWordCloudResults(clouds) {
  const map = new Map(); // word_lower → aggregate
  let firstSummary = '';
  for (const c of clouds) {
    const r = c.result || {};
    if (!firstSummary && r.summary) firstSummary = r.summary;
    for (const w of (r.words || [])) {
      const key = String(w.word || '').toLowerCase().trim();
      if (!key) continue;
      const cur = map.get(key) || {
        word: w.word, weightSum: 0, sources: 0, kept: false, count: 0, reasons: [],
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
  const words = [...map.values()].map(w => ({
    word: w.word,
    weight: Math.min(100, Math.round(w.weightSum + (w.count - 1) * 8)),
    sources: w.sources,
    kept: w.kept,
    reason: w.kept ? '' : (w.reasons[0] || ''),
  }));
  words.sort((a, b) => b.weight - a.weight);
  const labelList = clouds.map(c => `「${c.label}」`).join(' + ');
  return {
    summary: clouds.length === 2
      ? `${labelList} の合体クラウド (${words.length} 語)`
      : `${clouds.length} 件の関連クラウドを統合 (${words.length} 語)`,
    words: words.slice(0, 80),
    merged_from: clouds.map(c => ({ id: c.id, label: c.label })),
    base_summary: firstSummary,
  };
}

function buildRelatedPages(deps, wc, depth = 0) {
  const { db, getDigSession, getBookmark, listBookmarks, getWordCloud } = deps;
  if (!wc || depth > 2) return [];
  if (wc.origin === 'dig' && wc.origin_dig_id) {
    const dig = getDigSession(db, wc.origin_dig_id);
    if (!dig) return [];
    const r = dig.result || {};
    return (r.sources || []).map(s => ({
      url: s.url, title: s.title || s.url,
      snippet: (s.snippet || '').slice(0, 200), kind: 'dig-source',
    }));
  }
  if (wc.origin === 'bookmark' && wc.origin_bookmark_id) {
    const b = getBookmark(db, wc.origin_bookmark_id);
    return b ? [{ url: b.url, title: b.title, snippet: (b.summary || '').slice(0, 200), kind: 'bookmark' }] : [];
  }
  if (wc.origin === 'bookmarks') {
    return listBookmarks(db).slice(0, 16).map(b => ({
      url: b.url, title: b.title, snippet: (b.summary || '').slice(0, 200), kind: 'bookmark',
    }));
  }
  if (wc.origin === 'merged') {
    const out = [];
    const seen = new Set();
    for (const m of (wc.result?.merged_from || [])) {
      const child = getWordCloud(db, m.id);
      for (const p of buildRelatedPages(deps, child, depth + 1)) {
        if (seen.has(p.url)) continue;
        seen.add(p.url);
        out.push(p);
      }
    }
    return out.slice(0, 30);
  }
  return [];
}

export function createWordcloudRouter(deps) {
  const {
    db,
    listBookmarks,
    getDigSession,
    insertWordCloud,
    setWordCloudResult,
    getWordCloud,
    listWordClouds,
    enqueueCloud,
    validateWordRelevance,
  } = deps;
  const router = new Hono();

  router.post('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'body required' }, 400);
    const origin = body.origin;
    const parentCloudId = body.parentCloudId ?? null;
    const parentWord = typeof body.parentWord === 'string' ? body.parentWord : null;

    let label, docs, originDigId = null;

    if (origin === 'bookmarks') {
      const cat = body.category || null;
      const items = listBookmarks(db, { category: cat });
      if (items.length === 0) return c.json({ error: 'no bookmarks' }, 400);
      label = cat ? `bookmarks:${cat}` : 'all bookmarks';
      docs = buildBookmarksDocs({ db, listBookmarks, category: cat });
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

    const id = insertWordCloud(db, { origin, originDigId, parentCloudId, parentWord, label });
    enqueueCloud(id, { docs, label });
    return c.json({ id, queued: true });
  });

  router.get('/', (c) => {
    return c.json({ items: listWordClouds(db) });
  });

  router.get('/:id', (c) => {
    const id = Number(c.req.param('id'));
    const w = getWordCloud(db, id);
    if (!w) return c.json({ error: 'not found' }, 404);
    return c.json({ ...w, related_pages: buildRelatedPages(deps, w) });
  });

  router.get('/:id/graph', (c) => {
    const id = Number(c.req.param('id'));
    const radius = Math.min(3, Math.max(1, Number(c.req.query('radius')) || 3));
    if (!getWordCloud(db, id)) return c.json({ error: 'not found' }, 404);

    // BFS over parent_cloud_id (up) and child clouds (down).
    const seen = new Map(); // id → depth from current
    const queue = [{ id, depth: 0 }];
    seen.set(id, 0);
    while (queue.length > 0) {
      const { id: nid, depth } = queue.shift();
      if (depth >= radius) continue;
      const cur = db.prepare(`SELECT parent_cloud_id FROM word_clouds WHERE id = ?`).get(nid);
      if (cur?.parent_cloud_id && !seen.has(cur.parent_cloud_id)) {
        seen.set(cur.parent_cloud_id, depth + 1);
        queue.push({ id: cur.parent_cloud_id, depth: depth + 1 });
      }
      const children = db.prepare(`
        SELECT id FROM word_clouds WHERE parent_cloud_id = ? AND status = 'done'
      `).all(nid);
      for (const ch of children) {
        if (!seen.has(ch.id)) {
          seen.set(ch.id, depth + 1);
          queue.push({ id: ch.id, depth: depth + 1 });
        }
      }
    }

    // Count truncated branches (clouds at depth=radius that still have un-fetched
    // children — UI uses this to draw a "..." stub).
    const truncated = new Map(); // id → truncated_count
    for (const [nid, depth] of seen.entries()) {
      if (depth !== radius) continue;
      const childCount = db.prepare(`
        SELECT COUNT(*) AS n FROM word_clouds WHERE parent_cloud_id = ? AND status = 'done'
      `).get(nid)?.n ?? 0;
      if (childCount > 0) truncated.set(nid, childCount);
    }

    const nodes = [...seen.keys()].map(nid => {
      const wc = getWordCloud(db, nid);
      const r = wc?.result || {};
      const topWords = (r.words || []).filter(w => w.kept)
        .sort((a, b) => (b.weight || 0) - (a.weight || 0))
        .slice(0, 5)
        .map(w => ({ word: w.word, weight: w.weight }));
      const totalWeight = topWords.reduce((s, w) => s + (w.weight || 0), 0);
      return {
        id: nid,
        label: wc?.label || `cloud#${nid}`,
        parent_cloud_id: wc?.parent_cloud_id ?? null,
        parent_word: wc?.parent_word ?? null,
        origin: wc?.origin || '',
        depth: seen.get(nid),
        total_weight: totalWeight,
        top_words: topWords,
        summary: (r.summary || '').slice(0, 200),
        truncated_children: truncated.get(nid) ?? 0,
      };
    });
    const idsInGraph = new Set(seen.keys());
    const edges = nodes
      .filter(n => n.parent_cloud_id && idsInGraph.has(n.parent_cloud_id))
      .map(n => ({ from: n.parent_cloud_id, to: n.id, label: n.parent_word || '' }));

    return c.json({ current: id, radius, nodes, edges });
  });

  router.get('/:id/siblings', (c) => {
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

  router.post('/merge', async (c) => {
    const body = await c.req.json().catch(() => null);
    const cloudIds = Array.isArray(body?.cloudIds)
      ? body.cloudIds.map(Number).filter(Number.isFinite)
      : [];
    if (cloudIds.length < 2) return c.json({ error: 'cloudIds[] (>=2) required' }, 400);
    const clouds = cloudIds.map(id => getWordCloud(db, id)).filter(Boolean);
    const done = clouds.filter(c => c.status === 'done' && c.result);
    if (done.length < 2) return c.json({ error: 'need at least 2 completed clouds' }, 400);

    const merged = mergeWordCloudResults(done);
    const label = (typeof body?.label === 'string' && body.label.trim())
      ? body.label.trim().slice(0, 200)
      : `merged: ${done.map(d => d.label).join(' + ').slice(0, 160)}`;
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

  router.post('/validate-word', async (c) => {
    const body = await c.req.json().catch(() => null);
    const word = body?.word;
    const context = body?.context;
    if (!word || !context) return c.json({ error: 'word and context required' }, 400);
    try {
      const r = await validateWordRelevance({ word, context });
      return c.json(r);
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}
