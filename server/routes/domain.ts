// /api/domains* — ドメイン辞書 (page_visits の集約 + 各ドメインの分類)。
// Spec: spec/interface/domain.md

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  getDomainCatalog, listDomainCatalogWithCounts,
  insertDomainPending, setDomainCatalog, deleteDomainCatalog,
  updateDomainCatalogUser,
} from '../db.js';
import { classifyDomain, shouldSkipDomain } from '../domain-catalog.js';
import type { FifoQueue } from '../queue.js';

type Db = BetterSqlite3.Database;

export interface DomainRouterDeps {
  db: Db;
  domainCatalogQueue: FifoQueue;
  /** maybeQueueDomain: page-visits 集計から未分類ドメインを lazy 投入 */
  maybeQueueDomain: (url: string) => void;
}

export function makeDomainRouter(deps: DomainRouterDeps): Hono {
  const { db, domainCatalogQueue, maybeQueueDomain } = deps;
  const r = new Hono();

  // ---- ドメイン辞書: URL から domain 抽出して登録キューへ -------------------
  r.post('/api/domains/from-url', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { url?: unknown } | null;
    const url = String(body?.url ?? '').trim();
    if (!url) return c.json({ error: 'url required' }, 400);
    let domain: string;
    try {
      // bare host も許容: "example.com" → URL parse で失敗 → そのまま domain 扱い
      if (/^https?:\/\//i.test(url)) {
        domain = new URL(url).hostname.toLowerCase();
      } else if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(url)) {
        domain = url.toLowerCase().split('/')[0];
      } else {
        return c.json({ error: 'url or hostname required' }, 400);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `invalid url: ${msg}` }, 400);
    }
    if (shouldSkipDomain(domain)) return c.json({ error: 'localhost / loopback はスキップされます' }, 400);
    const existing = getDomainCatalog(db, domain);
    // 既存でも regenerate ルートと同じく再分類キューに積む
    insertDomainPending(db, domain);
    domainCatalogQueue.enqueue(async () => {
      const result = await classifyDomain({ domain });
      if ('skip' in result) { deleteDomainCatalog(db, domain); return; }
      if ('dropRow' in result) {
        setDomainCatalog(db, domain, { title: null, description: null, status: 'error', error: result.error ?? 'fetch failed' });
        return;
      }
      if (!result.ok) {
        setDomainCatalog(db, domain, { status: 'error', error: result.error });
        return;
      }
      setDomainCatalog(db, domain, {
        title: result.title, site_name: result.site_name,
        description: result.description, can_do: result.can_do,
        kind: result.kind, status: 'done', error: null,
      });
    }, { kind: 'domain', domain, title: domain });
    return c.json({ domain, queued: true, duplicate: !!existing }, 201);
  });

  r.get('/api/domains', (c: Context) => {
    const search = c.req.query('q')?.trim() || undefined;
    return c.json({ items: listDomainCatalogWithCounts(db, { search }) });
  });

  r.get('/api/domains/:domain', (c: Context) => {
    const d = (c.req.param('domain') ?? '').toLowerCase();
    const row = getDomainCatalog(db, d);
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json(row);
  });

  r.patch('/api/domains/:domain', async (c: Context) => {
    const d = (c.req.param('domain') ?? '').toLowerCase();
    const row = getDomainCatalog(db, d);
    if (!row) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    updateDomainCatalogUser(db, d, body);
    return c.json(getDomainCatalog(db, d));
  });

  r.post('/api/domains/:domain/regenerate', (c: Context) => {
    const d = (c.req.param('domain') ?? '').toLowerCase();
    if (shouldSkipDomain(d)) return c.json({ error: 'skipped domain' }, 400);
    // Force re-classify even if a row exists; the user_edited flag still
    // protects manual fields.
    insertDomainPending(db, d);
    domainCatalogQueue.enqueue(async () => {
      const result = await classifyDomain({ domain: d });
      if ('skip' in result) {
        deleteDomainCatalog(db, d);
        return;
      }
      if ('dropRow' in result) {
        setDomainCatalog(db, d, { title: null, description: null, status: 'error', error: result.error ?? 'fetch failed' });
        return;
      }
      if (!result.ok) {
        setDomainCatalog(db, d, { status: 'error', error: result.error });
        return;
      }
      setDomainCatalog(db, d, {
        title: result.title, site_name: result.site_name,
        description: result.description, can_do: result.can_do,
        kind: result.kind, status: 'done', error: null,
      });
    }, { kind: 'domain', domain: d, title: d });
    return c.json({ queued: true });
  });

  r.delete('/api/domains/:domain', (c: Context) => {
    const d = (c.req.param('domain') ?? '').toLowerCase();
    deleteDomainCatalog(db, d);
    return c.json({ ok: true });
  });

  /**
   * page_visits + visit_events に蓄積されたアクセス記録の全ドメインを走査し、
   * domain_catalog にまだ無いものを fetch + 分類キューに積む。
   *
   * - 既存 catalog 行 (status=done/pending/error) は skip
   * - localhost / 127.0.0.1 等の skip 対象も skip
   * - body の `force=true` で既存行も強制的に再キュー (regenerate と同じ挙動を一括適用)
   *
   * 既存の lazy `maybeQueueDomain` (アクセス時に 1 件ずつ enqueue) を補完する
   * メンテナンス用 batch。「過去のアクセスのうち未分類のドメインを今すぐ全部分類」
   * という用途。
   */
  r.post('/api/domains/recatalog-all', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { force?: unknown };
    const force = body?.force === true;

    // 2 ソースから unique URL を集める
    const visitedUrls = new Set<string>();
    for (const r of db.prepare(`SELECT DISTINCT url FROM page_visits`).all() as { url?: string }[]) {
      if (r.url) visitedUrls.add(r.url);
    }
    for (const r of db.prepare(`SELECT DISTINCT url FROM visit_events`).all() as { url?: string }[]) {
      if (r.url) visitedUrls.add(r.url);
    }

    // URL → unique domain
    const seenDomains = new Map<string, string>(); // domain -> sample url
    for (const url of visitedUrls) {
      const domain = extractDomainFromUrl(url);
      if (!domain) continue;
      if (!seenDomains.has(domain)) seenDomains.set(domain, url);
    }

    let queued = 0;
    let skippedExisting = 0;
    let skippedHost = 0;
    for (const [domain, sampleUrl] of seenDomains) {
      if (shouldSkipDomain(domain)) { skippedHost++; continue; }
      if (!force && getDomainCatalog(db, domain)) { skippedExisting++; continue; }
      if (force) {
        // regenerate と同じ流れ: pending 行を立てて、queue に積む
        insertDomainPending(db, domain);
        domainCatalogQueue.enqueue(async () => {
          const result = await classifyDomain({ domain });
          if ('skip' in result) {
            deleteDomainCatalog(db, domain);
            return;
          }
          if ('dropRow' in result) {
            setDomainCatalog(db, domain, { title: null, description: null, status: 'error', error: result.error ?? 'fetch failed' });
            return;
          }
          if (!result.ok) {
            setDomainCatalog(db, domain, { status: 'error', error: result.error });
            return;
          }
          setDomainCatalog(db, domain, {
            title: result.title, site_name: result.site_name,
            description: result.description, can_do: result.can_do,
            kind: result.kind, status: 'done', error: null,
          });
        }, { kind: 'domain', domain, title: domain });
      } else {
        // dedup 任せ (新ドメインだけが pending 行として入る)
        maybeQueueDomain(sampleUrl);
      }
      queued++;
    }

    return c.json({
      scanned_urls: visitedUrls.size,
      unique_domains: seenDomains.size,
      queued,
      skipped_existing: skippedExisting,
      skipped_host: skippedHost,
      queue_depth: domainCatalogQueue.depth,
      force,
    });
  });

  return r;
}

function extractDomainFromUrl(u: string): string | null {
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
}
