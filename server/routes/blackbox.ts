// /api/blackbox/* — 成長型ブラックボックスのレビュー & ルール管理。
//
// レビュー待ち判断 (pending_review) に人間が OK/NG を返し、 ルールの信頼を育てる。
// ルールの一覧 / 有効無効 / 手動追加もここ。 spec/feature/blackbox.md。

import { Hono, type Context } from 'hono';
import type { BlackBoxEngine, SqliteDecisionLedger } from '../blackbox/index.js';
import { validateCondition, describeCondition } from '../blackbox/index.js';

export interface BlackBoxRouterDeps {
  engine: BlackBoxEngine;
  ledger: SqliteDecisionLedger;
  /** ルール一覧で domain 未指定時に走査する既定ドメイン。 */
  knownDomains: string[];
}

export function makeBlackBoxRouter(deps: BlackBoxRouterDeps): Hono {
  const { engine, ledger } = deps;
  const r = new Hono();

  /** レビュー待ち (pending_review かつ未 verdict) の判断キュー。 */
  r.get('/api/blackbox/decisions', (c: Context) => {
    const url = new URL(c.req.url);
    const domain = url.searchParams.get('domain') || undefined;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const items = ledger.listPending(domain, limit);
    return c.json({ items });
  });

  /** 判断への OK/NG。 ルール由来なら信頼が更新され auto 化 / 撤回が進む。 */
  r.post('/api/blackbox/decisions/:id/verdict', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    const body = await c.req.json().catch(() => ({})) as { verdict?: unknown };
    if (body.verdict !== 'ok' && body.verdict !== 'ng') {
      return c.json({ error: "verdict must be 'ok' or 'ng'" }, 400);
    }
    const res = engine.recordVerdict(id, body.verdict);
    if (!res.ok) return c.json({ error: 'decision not found' }, 404);
    return c.json({ ok: true, rule: res.ruleUpdated ?? null });
  });

  /** ルール一覧 (domain 指定 or 既定ドメイン横断)。 説明文付き。 */
  r.get('/api/blackbox/rules', (c: Context) => {
    const url = new URL(c.req.url);
    const domain = url.searchParams.get('domain');
    const domains = domain ? [domain] : deps.knownDomains;
    const rules = domains.flatMap((d) => engine.listRules(d)).map((rule) => ({
      ...rule,
      whenText: describeCondition(rule.when),
    }));
    return c.json({ rules });
  });

  /** ルールの有効/無効切替。 */
  r.post('/api/blackbox/rules/:id/toggle', async (c: Context) => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'id required' }, 400);
    const body = await c.req.json().catch(() => ({})) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be boolean' }, 400);
    const rule = engine.toggleRule(id, body.enabled);
    if (!rule) return c.json({ error: 'rule not found' }, 404);
    return c.json({ ok: true, rule });
  });

  /** 手動ルール追加 (Condition は検証する)。 */
  r.post('/api/blackbox/rules', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.domain !== 'string' || !body.domain) return c.json({ error: 'domain required' }, 400);
    if (typeof body.description !== 'string') return c.json({ error: 'description required' }, 400);
    let when;
    try { when = validateCondition(body.when); }
    catch (e: unknown) { return c.json({ error: `invalid when: ${e instanceof Error ? e.message : String(e)}` }, 400); }
    const rule = engine.addRule({
      domain: body.domain,
      description: body.description,
      when,
      output: body.output ?? null,
      confidence: typeof body.confidence === 'number' ? body.confidence : undefined,
      priority: typeof body.priority === 'number' ? body.priority : undefined,
      enabled: body.enabled === false ? false : true,
      source: 'manual',
    });
    return c.json({ ok: true, rule });
  });

  return r;
}
