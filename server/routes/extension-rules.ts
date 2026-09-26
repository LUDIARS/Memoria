import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {getExtensionRules,setExtensionRules,type ExtensionRules,type ExtensionChatDomain,type ExtensionImplRule,type ExtensionShoppingDomain,type ExtensionNotionDomain,type ExtensionFurusatoDomain} from '../db.js';
import type {ExtensionRulesUpdateRequest} from '../api/types/extraction.js';
export function makeExtensionRulesRouter(db:BetterSqlite3.Database):Hono {
  const r=new Hono();
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
      furusato_domains: Array.isArray(body.furusato_domains)
        ? body.furusato_domains.filter((d): d is ExtensionFurusatoDomain =>
            !!d && typeof d.host === 'string')
        : cur.furusato_domains,
    };
    setExtensionRules(db, next);
    return c.json(next);
  });

  return r;
}
