import type BetterSqlite3 from 'better-sqlite3';
import { inventoryHistory } from './inventory-store.js';
import { jstDate } from './jsonl.js';
import { PRICE_TABLE_VERSION } from './price-table.js';
import { importDays } from './sync-window.js';
import { shiftDate, type UsagePeriod } from './usage-period.js';

type Db = BetterSqlite3.Database;
type Row = Record<string, unknown>;

/** Rows shown in the session table. Totals never come from this list. */
export const SESSION_LIST_LIMIT = 500;
const DAILY_LIMIT = 90;
const WEEKLY_LOOKBACK_DAYS = 104;

const TOTAL_TOKENS_SQL = `(input_tokens + cache_read_tokens + cache_write_5m_tokens
  + cache_write_1h_tokens + cache_write_unknown_tokens + output_tokens)`;

// Unpriced responses keep cost_usd NULL: SUM skips them, and they are counted
// separately so the UI shows them as unevaluated instead of $0.
const SUMMARY_SQL = `
  COUNT(*) AS responses,
  COUNT(DISTINCT provider || ':' || session_id) AS sessions,
  COUNT(DISTINCT provider || ':' || family_id) AS families,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_write_5m_tokens), 0) AS cache_write_5m_tokens,
  COALESCE(SUM(cache_write_1h_tokens), 0) AS cache_write_1h_tokens,
  COALESCE(SUM(cache_write_unknown_tokens), 0) AS cache_write_unknown_tokens,
  COALESCE(SUM(cache_write_5m_tokens + cache_write_1h_tokens + cache_write_unknown_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(${TOTAL_TOKENS_SQL}), 0) AS total_tokens,
  COALESCE(SUM(cost_usd), 0) AS cost_usd,
  COALESCE(SUM(cost_input_usd), 0) AS cost_input_usd,
  COALESCE(SUM(cost_cache_read_usd), 0) AS cost_cache_read_usd,
  COALESCE(SUM(cost_cache_write_usd), 0) AS cost_cache_write_usd,
  COALESCE(SUM(cost_output_usd), 0) AS cost_output_usd,
  COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced_responses,
  COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN ${TOTAL_TOKENS_SQL} ELSE 0 END), 0) AS unpriced_tokens,
  SUM(codex_credits) AS codex_credits,
  COALESCE(SUM(CASE WHEN provider = 'codex-cli' AND codex_credits IS NULL THEN 1 ELSE 0 END), 0)
    AS codex_uncredited_responses,
  MIN(usage_date) AS date_from, MAX(usage_date) AS date_to
`;

export function usageDashboard(db: Db, period: UsagePeriod, nowMs = Date.now()): Row {
  const today = jstDate(nowMs);
  const summary = (where: string, ...params: unknown[]): Row => withHitRate(
    db.prepare(`SELECT ${SUMMARY_SQL} FROM llm_usage_responses ${where}`).get(...params) as Row,
  );
  const periodWhere = 'WHERE usage_date >= ? AND usage_date <= ?';
  const daily = db.prepare(`
    SELECT usage_date AS date, ${SUMMARY_SQL}
    FROM llm_usage_responses GROUP BY usage_date ORDER BY usage_date DESC LIMIT ${DAILY_LIMIT}
  `).all() as Row[];
  const byModel = db.prepare(`
    SELECT provider, model, cost_basis, ${SUMMARY_SQL}
    FROM llm_usage_responses ${periodWhere}
    GROUP BY provider, model, cost_basis ORDER BY cost_usd DESC, total_tokens DESC
  `).all(period.from, period.to) as Row[];
  const byEffort = db.prepare(`
    SELECT provider, effort, ${SUMMARY_SQL}
    FROM llm_usage_responses ${periodWhere}
    GROUP BY provider, effort ORDER BY cost_usd DESC
  `).all(period.from, period.to) as Row[];
  // Subagent responses are attributed to their parent session, so a family row
  // is the parent plus every child agent it spawned.
  const families = db.prepare(`
    SELECT provider, family_id AS session_id, MIN(occurred_at) AS started_at, MAX(occurred_at) AS ended_at,
      MAX(repo_path) AS repo_name, COUNT(DISTINCT agent_id) AS subagents,
      GROUP_CONCAT(DISTINCT model) AS models, GROUP_CONCAT(DISTINCT effort) AS efforts,
      GROUP_CONCAT(DISTINCT cost_basis) AS cost_basis, ${SUMMARY_SQL}
    FROM llm_usage_responses ${periodWhere}
    GROUP BY provider, family_id ORDER BY ended_at DESC LIMIT ${SESSION_LIST_LIMIT}
  `).all(period.from, period.to) as Row[];
  const sources = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failed,
      MAX(imported_at) AS last_imported_at
    FROM llm_usage_sources
  `).get();
  const legacy = db.prepare(`
    SELECT COUNT(*) AS records, MIN(usage_date) AS date_from, MAX(usage_date) AS date_to
    FROM llm_usage_records
  `).get();
  const periodSummary = summary(periodWhere, period.from, period.to);
  return {
    today: summary('WHERE usage_date = ?', today),
    total: summary(''),
    daily: daily.map(withHitRate),
    weekly: weeklyTrend(db, shiftDate(today, -WEEKLY_LOOKBACK_DAYS)),
    period: {
      from: period.from,
      to: period.to,
      summary: periodSummary,
      by_model: byModel.map(withHitRate),
      by_effort: byEffort.map(withHitRate),
      sessions_total: periodSummary.families,
      sessions_truncated: Number(periodSummary.families) > families.length,
    },
    sessions: families.map((row) => withHitRate({
      ...row,
      // The UI needs only a project label; never expose a local absolute path.
      repo_name: repositoryName(row.repo_name),
    })),
    inventory: inventoryHistory(db),
    sources,
    legacy,
    methodology: {
      currency: 'USD',
      cost_kind: 'official_api_list_price_equivalent',
      not_billing: 'Not an invoice, not subscription quota. Codex credits are a separate unit.',
      price_version: PRICE_TABLE_VERSION,
      price_sources: [
        'https://platform.claude.com/docs/en/about-claude/pricing',
        'https://developers.openai.com/api/docs/pricing',
        'https://learn.chatgpt.com/docs/pricing',
      ],
      unpriced: 'Models without an official price are counted in unpriced_* and excluded from cost_usd.',
      cache_write_unknown: 'Cache writes without a TTL breakdown are priced at the 5-minute rate (lower bound).',
      cache_hit_rate: 'cache read / (uncached input + cache read + cache write)',
      contexts: 'Unique provider responses (Claude message.id / Codex token_count increases)',
      initial_import_days: importDays(),
    },
  };
}

function weeklyTrend(db: Db, fromDate: string): Row[] {
  const rows = db.prepare(`
    SELECT usage_date AS date, provider || ':' || family_id AS family,
      COUNT(*) AS contexts, SUM(${TOTAL_TOKENS_SQL}) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost_usd
    FROM llm_usage_responses WHERE usage_date >= ?
    GROUP BY usage_date, provider, family_id
  `).all(fromDate) as Row[];
  const weeks = new Map<string, { week: string; cost_usd: number; tokens: number; contexts: number; families: Set<string> }>();
  for (const row of rows) {
    const key = isoWeek(String(row.date));
    const group = weeks.get(key) ?? { week: key, cost_usd: 0, tokens: 0, contexts: 0, families: new Set<string>() };
    group.cost_usd += Number(row.cost_usd) || 0;
    group.tokens += Number(row.tokens) || 0;
    group.contexts += Number(row.contexts) || 0;
    group.families.add(String(row.family));
    weeks.set(key, group);
  }
  return [...weeks.values()]
    .map(({ families, ...row }) => ({ ...row, sessions: families.size }))
    .sort((a, b) => b.week.localeCompare(a.week))
    .slice(0, 14);
}

function isoWeek(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((value.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function withHitRate(row: Row): Row {
  const uncached = Number(row.input_tokens) || 0;
  const cached = Number(row.cache_read_tokens) || 0;
  const written = Number(row.cache_write_tokens) || 0;
  const denominator = uncached + cached + written;
  return { ...row, contexts: row.responses, cache_hit_rate: denominator > 0 ? cached / denominator : null };
}

function repositoryName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? null;
}
