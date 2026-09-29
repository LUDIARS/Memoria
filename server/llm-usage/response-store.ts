import type BetterSqlite3 from 'better-sqlite3';
import { estimateResponseCost } from './cost-estimator.js';
import { PRICE_TABLE_VERSION } from './price-table.js';
import { mergeResponse } from './response-merge.js';
import { markSourceImported } from './source-store.js';
import type { CostEstimate, LlmProvider, ParsedUsageSource, SourceSignature, UsageResponse } from './types.js';

type Db = BetterSqlite3.Database;

interface ResponseRow {
  provider: LlmProvider;
  response_id: string;
  session_id: string;
  agent_id: string | null;
  family_id: string;
  is_origin: number;
  source_path: string;
  occurred_at: string;
  occurred_ms: number;
  usage_date: string;
  model: string;
  effort: string;
  repo_path: string | null;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  cache_write_unknown_tokens: number;
  output_tokens: number;
}

const UPSERT_SQL = `
  INSERT INTO llm_usage_responses (
    provider, response_id, session_id, agent_id, family_id, is_origin, source_path,
    occurred_at, occurred_ms, usage_date, model, effort, repo_path,
    input_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
    cache_write_unknown_tokens, output_tokens,
    cost_usd, cost_input_usd, cost_cache_read_usd, cost_cache_write_usd, cost_output_usd,
    cost_basis, codex_credits, price_version, imported_at
  ) VALUES (
    @provider, @response_id, @session_id, @agent_id, @family_id, @is_origin, @source_path,
    @occurred_at, @occurred_ms, @usage_date, @model, @effort, @repo_path,
    @input_tokens, @cache_read_tokens, @cache_write_5m_tokens, @cache_write_1h_tokens,
    @cache_write_unknown_tokens, @output_tokens,
    @cost_usd, @cost_input_usd, @cost_cache_read_usd, @cost_cache_write_usd, @cost_output_usd,
    @cost_basis, @codex_credits, @price_version, @imported_at
  )
  ON CONFLICT(provider, response_id) DO UPDATE SET
    session_id=excluded.session_id, agent_id=excluded.agent_id, family_id=excluded.family_id,
    is_origin=excluded.is_origin, source_path=excluded.source_path,
    occurred_at=excluded.occurred_at, occurred_ms=excluded.occurred_ms, usage_date=excluded.usage_date,
    model=excluded.model, effort=excluded.effort, repo_path=excluded.repo_path,
    input_tokens=excluded.input_tokens, cache_read_tokens=excluded.cache_read_tokens,
    cache_write_5m_tokens=excluded.cache_write_5m_tokens, cache_write_1h_tokens=excluded.cache_write_1h_tokens,
    cache_write_unknown_tokens=excluded.cache_write_unknown_tokens, output_tokens=excluded.output_tokens,
    cost_usd=excluded.cost_usd, cost_input_usd=excluded.cost_input_usd,
    cost_cache_read_usd=excluded.cost_cache_read_usd, cost_cache_write_usd=excluded.cost_cache_write_usd,
    cost_output_usd=excluded.cost_output_usd, cost_basis=excluded.cost_basis,
    codex_credits=excluded.codex_credits, price_version=excluded.price_version,
    imported_at=excluded.imported_at
`;

/**
 * Store the responses one source yielded. Rows are keyed by provider response
 * id, so re-running the same sync or reading a copied / archived log merges into
 * the existing row instead of adding usage again. Rows are never deleted: usage
 * outside the discovery window survives native log rotation.
 */
export function importSourceResponses(
  db: Db,
  source: SourceSignature,
  parsed: ParsedUsageSource,
  importedAt = new Date().toISOString(),
): number {
  const select = db.prepare('SELECT * FROM llm_usage_responses WHERE provider = ? AND response_id = ?');
  const upsert = db.prepare(UPSERT_SQL);
  return db.transaction(() => {
    for (const incoming of parsed.responses) {
      const row = select.get(incoming.provider, incoming.responseId) as ResponseRow | undefined;
      const response = row ? mergeResponse(fromRow(row), incoming) : incoming;
      const cost = estimateResponseCost(response.provider, response.model, response);
      upsert.run(toRow(response, cost, importedAt));
    }
    markSourceImported(db, source, parsed.sessionId, importedAt);
    return parsed.responses.length;
  })();
}

/** Re-price stored responses priced under another rate-table version; returns the count. */
export function repriceStaleResponses(db: Db): number {
  const stale = db.prepare(
    'SELECT * FROM llm_usage_responses WHERE price_version <> ?',
  ).all(PRICE_TABLE_VERSION) as ResponseRow[];
  const update = db.prepare(`
    UPDATE llm_usage_responses SET
      cost_usd=@cost_usd, cost_input_usd=@cost_input_usd, cost_cache_read_usd=@cost_cache_read_usd,
      cost_cache_write_usd=@cost_cache_write_usd, cost_output_usd=@cost_output_usd,
      cost_basis=@cost_basis, codex_credits=@codex_credits, price_version=@price_version
    WHERE provider=@provider AND response_id=@response_id
  `);
  db.transaction(() => {
    for (const row of stale) {
      const response = fromRow(row);
      update.run({
        provider: row.provider,
        response_id: row.response_id,
        ...costColumns(estimateResponseCost(response.provider, response.model, response)),
      });
    }
  })();
  return stale.length;
}

function fromRow(row: ResponseRow): UsageResponse {
  return {
    provider: row.provider,
    responseId: row.response_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    familyId: row.family_id,
    isOrigin: row.is_origin === 1,
    sourcePath: row.source_path,
    occurredAt: row.occurred_at,
    occurredMs: row.occurred_ms,
    usageDate: row.usage_date,
    model: row.model,
    effort: row.effort,
    repoPath: row.repo_path,
    inputTokens: row.input_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWrite5mTokens: row.cache_write_5m_tokens,
    cacheWrite1hTokens: row.cache_write_1h_tokens,
    cacheWriteUnknownTokens: row.cache_write_unknown_tokens,
    outputTokens: row.output_tokens,
  };
}

function toRow(response: UsageResponse, cost: CostEstimate, importedAt: string): Record<string, unknown> {
  return {
    provider: response.provider,
    response_id: response.responseId,
    session_id: response.sessionId,
    agent_id: response.agentId,
    family_id: response.familyId,
    is_origin: response.isOrigin ? 1 : 0,
    source_path: response.sourcePath,
    occurred_at: response.occurredAt,
    occurred_ms: response.occurredMs,
    usage_date: response.usageDate,
    model: response.model,
    effort: response.effort,
    repo_path: response.repoPath,
    input_tokens: response.inputTokens,
    cache_read_tokens: response.cacheReadTokens,
    cache_write_5m_tokens: response.cacheWrite5mTokens,
    cache_write_1h_tokens: response.cacheWrite1hTokens,
    cache_write_unknown_tokens: response.cacheWriteUnknownTokens,
    output_tokens: response.outputTokens,
    ...costColumns(cost),
    imported_at: importedAt,
  };
}

function costColumns(cost: CostEstimate): Record<string, unknown> {
  return {
    cost_usd: cost.usd,
    cost_input_usd: cost.breakdown?.inputUsd ?? null,
    cost_cache_read_usd: cost.breakdown?.cacheReadUsd ?? null,
    cost_cache_write_usd: cost.breakdown?.cacheWriteUsd ?? null,
    cost_output_usd: cost.breakdown?.outputUsd ?? null,
    cost_basis: cost.basis,
    codex_credits: cost.codexCredits,
    price_version: cost.priceVersion,
  };
}
