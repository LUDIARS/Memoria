import type BetterSqlite3 from 'better-sqlite3';
import type { ParsedUsageSource, SourceSignature, UsageRecord } from './types.js';

type Db = BetterSqlite3.Database;

interface SourceRow { modified_ms: number; size_bytes: number; error: string | null }

export function isSourceCurrent(db: Db, source: SourceSignature): boolean {
  const row = db.prepare(
    'SELECT modified_ms, size_bytes, error FROM llm_usage_sources WHERE source_path = ?',
  ).get(source.path) as SourceRow | undefined;
  return !!row && row.error === null
    && row.modified_ms === source.modifiedMs && row.size_bytes === source.sizeBytes;
}

export function replaceSourceUsage(
  db: Db,
  source: SourceSignature,
  parsed: ParsedUsageSource,
  replaceFromDate: string,
  importedAt = new Date().toISOString(),
): number {
  const upsertSource = db.prepare(`
    INSERT INTO llm_usage_sources (
      source_path, provider, session_id, modified_ms, size_bytes, imported_at, error
    ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(source_path) DO UPDATE SET
      provider=excluded.provider, session_id=excluded.session_id,
      modified_ms=excluded.modified_ms, size_bytes=excluded.size_bytes,
      imported_at=excluded.imported_at, error=NULL
  `);
  const insertRecord = db.prepare(`
    INSERT INTO llm_usage_records (
      source_path, session_id, provider, usage_date, model, effort, repo_path,
      started_at, ended_at, context_count, input_tokens, cached_input_tokens,
      cache_write_5m_tokens, cache_write_1h_tokens, output_tokens, total_tokens,
      cost_usd, cost_basis, imported_at
    ) VALUES (
      @source_path, @session_id, @provider, @usage_date, @model, @effort, @repo_path,
      @started_at, @ended_at, @context_count, @input_tokens, @cached_input_tokens,
      @cache_write_5m_tokens, @cache_write_1h_tokens, @output_tokens, @total_tokens,
      @cost_usd, @cost_basis, @imported_at
    )
  `);
  return db.transaction(() => {
    upsertSource.run(
      source.path, parsed.provider, parsed.sessionId,
      source.modifiedMs, source.sizeBytes, importedAt,
    );
    // Rebuild only the moving import window. Older daily aggregates remain in
    // Memoria even after native logs rotate or age beyond the discovery window.
    db.prepare(
      'DELETE FROM llm_usage_records WHERE source_path = ? AND usage_date >= ?',
    ).run(source.path, replaceFromDate);
    for (const record of parsed.records) insertRecord.run(toSql(record, importedAt));
    return parsed.records.length;
  })();
}

export function recordSourceFailure(
  db: Db,
  source: SourceSignature,
  error: string,
  importedAt = new Date().toISOString(),
): void {
  db.prepare(`
    INSERT INTO llm_usage_sources (
      source_path, provider, session_id, modified_ms, size_bytes, imported_at, error
    ) VALUES (?, ?, NULL, ?, ?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET
      modified_ms=excluded.modified_ms, size_bytes=excluded.size_bytes,
      imported_at=excluded.imported_at, error=excluded.error
  `).run(source.path, source.provider, source.modifiedMs, source.sizeBytes, importedAt, error.slice(0, 500));
}

export function usageDashboard(db: Db): Record<string, unknown> {
  const total = aggregateRow(db.prepare(`
    SELECT COUNT(DISTINCT provider || ':' || session_id) AS sessions,
      COALESCE(SUM(context_count), 0) AS contexts,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(cache_write_5m_tokens + cache_write_1h_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(cost_usd), 0) AS cost_usd,
      MIN(usage_date) AS date_from, MAX(usage_date) AS date_to
    FROM llm_usage_records
  `).get());
  const today = localDate(new Date());
  const todaySummary = aggregateRow(db.prepare(`
    SELECT COUNT(DISTINCT provider || ':' || session_id) AS sessions,
      COALESCE(SUM(context_count), 0) AS contexts,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(cache_write_5m_tokens + cache_write_1h_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(cost_usd), 0) AS cost_usd,
      MIN(usage_date) AS date_from, MAX(usage_date) AS date_to
    FROM llm_usage_records WHERE usage_date = ?
  `).get(today));
  const daily = db.prepare(`
    SELECT usage_date AS date,
      COUNT(DISTINCT provider || ':' || session_id) AS sessions,
      SUM(context_count) AS contexts,
      SUM(input_tokens) AS input_tokens,
      SUM(cached_input_tokens) AS cached_input_tokens,
      SUM(cache_write_5m_tokens + cache_write_1h_tokens) AS cache_write_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(total_tokens) AS total_tokens,
      SUM(cost_usd) AS cost_usd
    FROM llm_usage_records GROUP BY usage_date ORDER BY usage_date DESC LIMIT 90
  `).all() as Array<Record<string, number | string>>;
  const weeklyInputs = db.prepare(`
    SELECT usage_date AS date, provider, session_id, context_count AS contexts,
      total_tokens, cost_usd
    FROM llm_usage_records
    WHERE usage_date >= date('now', '-104 days')
  `).all() as Array<Record<string, number | string>>;
  const sessions = db.prepare(`
    SELECT provider, session_id, MIN(started_at) AS started_at, MAX(ended_at) AS ended_at,
      MAX(repo_path) AS repo_name, SUM(context_count) AS contexts,
      SUM(input_tokens) AS input_tokens, SUM(cached_input_tokens) AS cached_input_tokens,
      SUM(cache_write_5m_tokens + cache_write_1h_tokens) AS cache_write_tokens,
      SUM(output_tokens) AS output_tokens, SUM(total_tokens) AS total_tokens,
      SUM(cost_usd) AS cost_usd,
      GROUP_CONCAT(DISTINCT model) AS models,
      GROUP_CONCAT(DISTINCT effort) AS efforts,
      GROUP_CONCAT(DISTINCT cost_basis) AS cost_basis
    FROM llm_usage_records
    GROUP BY provider, session_id
    ORDER BY ended_at DESC, started_at DESC LIMIT 500
  `).all() as Array<Record<string, unknown>>;
  const sources = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failed,
      MAX(imported_at) AS last_imported_at
    FROM llm_usage_sources
  `).get();
  const inventory = inventoryHistory(db);
  return {
    today: withHitRate(todaySummary),
    total: withHitRate(total),
    daily: daily.map(withHitRate),
    weekly: weeklyTrend(weeklyInputs),
    sessions: sessions.map((row) => withHitRate({
      ...row,
      // The UI needs only a project label; never expose a local absolute path.
      repo_name: repositoryName(row.repo_name),
    })),
    inventory,
    sources,
    methodology: {
      currency: 'USD',
      cost_kind: 'equivalent_api_estimate',
      reference: 'Villa /session-costs',
      cache_hit_rate: 'cache read / (uncached input + cache read + cache write)',
      contexts: 'Codex turn_context / Claude deduplicated usage responses',
      initial_import_days: importDays(),
    },
  };
}

export function saveInventorySnapshot(db: Db, snapshot: {
  capturedAt: string;
  skillCount: number;
  memoryCount: number;
  geniusCardCount: number | null;
  judgmentLogCount: number;
  localLlms: unknown[];
  sourceErrors: string[];
}): void {
  db.prepare(`
    INSERT INTO llm_inventory_snapshots (
      snapshot_date, captured_at, skill_count, memory_count, genius_card_count,
      judgment_log_count, local_llms_json, source_errors_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_date) DO UPDATE SET
      captured_at=excluded.captured_at, skill_count=excluded.skill_count,
      memory_count=excluded.memory_count, genius_card_count=excluded.genius_card_count,
      judgment_log_count=excluded.judgment_log_count,
      local_llms_json=excluded.local_llms_json, source_errors_json=excluded.source_errors_json
  `).run(
    localDate(new Date(snapshot.capturedAt)), snapshot.capturedAt,
    snapshot.skillCount, snapshot.memoryCount, snapshot.geniusCardCount,
    snapshot.judgmentLogCount, JSON.stringify(snapshot.localLlms), JSON.stringify(snapshot.sourceErrors),
  );
}

function inventoryHistory(db: Db): Array<Record<string, unknown>> {
  const rows = db.prepare(`
    SELECT snapshot_date, captured_at, skill_count, memory_count, genius_card_count,
      judgment_log_count, local_llms_json
    FROM llm_inventory_snapshots ORDER BY snapshot_date DESC LIMIT 90
  `).all() as Array<Record<string, unknown>>;
  return rows.map((row, index) => {
    const previous = rows[index + 1];
    return {
      date: row.snapshot_date,
      captured_at: row.captured_at,
      skills: metric(row.skill_count, previous?.skill_count),
      memories: metric(row.memory_count, previous?.memory_count),
      genius_cards: metric(row.genius_card_count, previous?.genius_card_count),
      judgment_logs: metric(row.judgment_log_count, previous?.judgment_log_count),
      local_llms: publicLocalLlms(row.local_llms_json),
    };
  });
}

function metric(value: unknown, previous: unknown): { value: number | null; delta: number | null } {
  const current = typeof value === 'number' ? value : null;
  const before = typeof previous === 'number' ? previous : null;
  return { value: current, delta: current !== null && before !== null ? current - before : null };
}

function weeklyTrend(daily: Array<Record<string, number | string>>): Array<Record<string, unknown>> {
  const weeks = new Map<string, {
    week: string;
    cost_usd: number;
    tokens: number;
    sessionIds: Set<string>;
    contexts: number;
  }>();
  for (const row of daily) {
    const key = isoWeek(String(row.date));
    const group = weeks.get(key) ?? {
      week: key, cost_usd: 0, tokens: 0, sessionIds: new Set<string>(), contexts: 0,
    };
    group.cost_usd += Number(row.cost_usd) || 0;
    group.tokens += Number(row.total_tokens) || 0;
    group.contexts += Number(row.contexts) || 0;
    group.sessionIds.add(`${row.provider}:${row.session_id}`);
    weeks.set(key, group);
  }
  return [...weeks.values()]
    .map(({ sessionIds, ...row }) => ({ ...row, sessions: sessionIds.size }))
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

function aggregateRow(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function withHitRate<T extends Record<string, unknown>>(row: T): T & { cache_hit_rate: number | null } {
  const uncached = Number(row.input_tokens) || 0;
  const cached = Number(row.cached_input_tokens) || 0;
  const written = Number(row.cache_write_tokens) || 0;
  const denominator = uncached + cached + written;
  return { ...row, cache_hit_rate: denominator > 0 ? cached / denominator : null };
}

function toSql(record: UsageRecord, importedAt: string): Record<string, unknown> {
  return {
    source_path: record.sourcePath,
    session_id: record.sessionId,
    provider: record.provider,
    usage_date: record.usageDate,
    model: record.model,
    effort: record.effort,
    repo_path: record.repoPath,
    started_at: record.startedAt,
    ended_at: record.endedAt,
    context_count: record.contexts,
    input_tokens: record.inputTokens,
    cached_input_tokens: record.cachedInputTokens,
    cache_write_5m_tokens: record.cacheWrite5mTokens,
    cache_write_1h_tokens: record.cacheWrite1hTokens,
    output_tokens: record.outputTokens,
    total_tokens: record.totalTokens,
    cost_usd: record.costUsd,
    cost_basis: record.costBasis,
    imported_at: importedAt,
  };
}

function localDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return [];
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // A corrupt historical snapshot must not break the whole local dashboard.
    return [];
  }
}

function publicLocalLlms(value: unknown): Array<{
  configuredModel: string;
  available: boolean;
  models: Array<{ id: string }>;
}> {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const runtime = item as Record<string, unknown>;
    const models = Array.isArray(runtime.models)
      ? runtime.models.flatMap((model) => {
        if (!model || typeof model !== 'object') return [];
        const id = (model as Record<string, unknown>).id;
        return typeof id === 'string' ? [{ id }] : [];
      })
      : [];
    return [{
      configuredModel: typeof runtime.configuredModel === 'string' ? runtime.configuredModel : '',
      available: runtime.available === true,
      models,
    }];
  });
}

function repositoryName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? null;
}

export function importDays(): number {
  const configured = Number(process.env.MEMORIA_LLM_IMPORT_DAYS ?? '8');
  if (!Number.isFinite(configured)) return 8;
  return Math.min(90, Math.max(1, Math.floor(configured)));
}
