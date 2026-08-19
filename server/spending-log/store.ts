import type BetterSqlite3 from 'better-sqlite3';
import {
  SPENDING_LOG_PRIVACY_CLASS,
  SpendingLogRecordSchema,
  type DailySpendingSummary,
  type QuaestorSpendingLogExport,
  type SpendingLogRecord,
} from './contract.js';
import {
  DIARY_ONLY_SCOPE,
  SPENDING_ADVICE_SCOPE,
  resolveEffectiveRelayScope,
  type LlmRelayScope,
} from './relay-policy.js';

type Db = BetterSqlite3.Database;

interface StoredRow {
  id: string;
  privacy_class: typeof SPENDING_LOG_PRIVACY_CLASS;
  retention_scope: 'local_only';
  llm_relay_scope: LlmRelayScope;
  source_kind: 'transaction' | 'receipt';
  occurred_on: string;
  occurred_at: string | null;
  amount: number;
  currency: string;
  place_name: string | null;
  google_place_id: string | null;
  google_maps_url: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
  payment_json: string;
  items_json: string;
  purchase_category: SpendingLogRecord['purchase_category'];
  expense_planned: number | null;
  expense_rate: number | null;
  expense_rule_id: number | null;
  source_refs_json: string;
  source_updated_at: string;
}

export interface SpendingLogFilter {
  dateFrom?: string;
  dateTo?: string;
  /** 'receipt' = レシート、 'transaction' = クレカ / 銀行等の取引明細。 */
  sourceKind?: SpendingLogRecord['source_kind'];
  /** 指定すると、 その scope で LLM に渡してよい行だけを返す。 */
  relayScope?: LlmRelayScope;
}

export interface ReplaceResult {
  inserted_or_updated: number;
  removed: number;
}

export function replaceQuaestorRange(
  db: Db,
  exported: QuaestorSpendingLogExport,
  syncedAt = new Date().toISOString(),
  hasSpendingAdviceConsent = false,
): ReplaceResult {
  const upsert = db.prepare(`
    INSERT INTO sensitive_spending_logs (
      id, privacy_class, retention_scope, llm_relay_scope, source_service, source_kind,
      occurred_on, occurred_at, amount, currency,
      place_name, google_place_id, google_maps_url, latitude, longitude, accuracy_m,
      payment_json, items_json, purchase_category,
      expense_planned, expense_rate, expense_rule_id,
      source_refs_json, source_updated_at, synced_at
    ) VALUES (
      @id, @privacy_class, @retention_scope, @llm_relay_scope, 'quaestor', @source_kind,
      @occurred_on, @occurred_at, @amount, @currency,
      @place_name, @google_place_id, @google_maps_url, @latitude, @longitude, @accuracy_m,
      @payment_json, @items_json, @purchase_category,
      @expense_planned, @expense_rate, @expense_rule_id,
      @source_refs_json, @source_updated_at, @synced_at
    )
    ON CONFLICT(id) DO UPDATE SET
      privacy_class = excluded.privacy_class,
      retention_scope = excluded.retention_scope,
      llm_relay_scope = excluded.llm_relay_scope,
      source_kind = excluded.source_kind,
      occurred_on = excluded.occurred_on,
      occurred_at = excluded.occurred_at,
      amount = excluded.amount,
      currency = excluded.currency,
      place_name = excluded.place_name,
      google_place_id = excluded.google_place_id,
      google_maps_url = excluded.google_maps_url,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      accuracy_m = excluded.accuracy_m,
      payment_json = excluded.payment_json,
      items_json = excluded.items_json,
      purchase_category = excluded.purchase_category,
      expense_planned = excluded.expense_planned,
      expense_rate = excluded.expense_rate,
      expense_rule_id = excluded.expense_rule_id,
      source_refs_json = excluded.source_refs_json,
      source_updated_at = excluded.source_updated_at,
      synced_at = excluded.synced_at
  `);
  const existing = db.prepare(
    `SELECT id FROM sensitive_spending_logs
     WHERE source_service = 'quaestor' AND occurred_on >= ? AND occurred_on <= ?`,
  );
  const remove = db.prepare(`DELETE FROM sensitive_spending_logs WHERE id = ?`);

  return db.transaction((): ReplaceResult => {
    const incomingIds = new Set(exported.records.map((record) => record.id));
    let removed = 0;
    for (const row of existing.all(exported.date_from, exported.date_to) as Array<{ id: string }>) {
      if (!incomingIds.has(row.id)) removed += remove.run(row.id).changes;
    }
    for (const record of exported.records) {
      upsert.run(toSqlParams(record, syncedAt, hasSpendingAdviceConsent));
    }
    return { inserted_or_updated: exported.records.length, removed };
  })();
}

export function listSpendingLogs(db: Db, filter: SpendingLogFilter = {}): SpendingLogRecord[] {
  const where: string[] = [];
  const params: Record<string, string> = {};
  if (filter.dateFrom) {
    where.push('occurred_on >= @date_from');
    params.date_from = filter.dateFrom;
  }
  if (filter.dateTo) {
    where.push('occurred_on <= @date_to');
    params.date_to = filter.dateTo;
  }
  if (filter.sourceKind) {
    where.push('source_kind = @source_kind');
    params.source_kind = filter.sourceKind;
  }
  if (filter.relayScope) {
    where.push('llm_relay_scope = @relay_scope');
    params.relay_scope = filter.relayScope;
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT * FROM sensitive_spending_logs
     ${whereSql}
     ORDER BY occurred_on DESC, occurred_at DESC, id DESC`,
  ).all(params) as StoredRow[];
  return rows.map(fromStoredRow);
}

export function summarizeSpendingLogs(records: SpendingLogRecord[]): DailySpendingSummary[] {
  const groups = new Map<string, {
    date: string;
    currency: string;
    total: number;
    places: Map<string, DailySpendingSummary['places'][number]>;
  }>();
  for (const record of records) {
    const key = `${record.date}\u0000${record.currency}`;
    const group = groups.get(key) ?? {
      date: record.date,
      currency: record.currency,
      total: 0,
      places: new Map(),
    };
    group.total += record.amount;
    const placeKey = record.place.google_maps_url ?? record.place.name ?? 'undetermined';
    const place = group.places.get(placeKey) ?? {
      name: record.place.name,
      google_maps_url: record.place.google_maps_url,
      amount: 0,
    };
    place.amount += record.amount;
    group.places.set(placeKey, place);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.date.localeCompare(a.date) || a.currency.localeCompare(b.currency))
    .map((group) => ({
      date: group.date,
      currency: group.currency,
      total_amount: group.total,
      places: [...group.places.values()].sort((a, b) => b.amount - a.amount),
    }));
}

/**
 * 本人同意の切り替えを保存済みの行にも反映する。 同意 ON で diary_only の行を昇格、
 * OFF で助言 scope の行を diary_only へ戻す。 戻す方向は取り消しなので許す。
 */
export function applyRelayConsent(db: Db, hasSpendingAdviceConsent: boolean): number {
  const target = hasSpendingAdviceConsent ? SPENDING_ADVICE_SCOPE : DIARY_ONLY_SCOPE;
  return db.prepare(
    `UPDATE sensitive_spending_logs SET llm_relay_scope = ? WHERE llm_relay_scope <> ?`,
  ).run(target, target).changes;
}

function toSqlParams(
  record: SpendingLogRecord,
  syncedAt: string,
  hasSpendingAdviceConsent: boolean,
): Record<string, unknown> {
  return {
    id: record.id,
    privacy_class: record.privacy_class,
    retention_scope: record.retention_scope,
    llm_relay_scope: resolveEffectiveRelayScope(hasSpendingAdviceConsent),
    source_kind: record.source_kind,
    occurred_on: record.date,
    occurred_at: record.occurred_at,
    amount: record.amount,
    currency: record.currency,
    place_name: record.place.name,
    google_place_id: record.place.google_place_id,
    google_maps_url: record.place.google_maps_url,
    latitude: record.place.location?.latitude ?? null,
    longitude: record.place.location?.longitude ?? null,
    accuracy_m: record.place.location?.accuracy_m ?? null,
    payment_json: JSON.stringify(record.payment),
    items_json: JSON.stringify(record.items),
    purchase_category: record.purchase_category,
    expense_planned: record.expense.planned === null ? null : record.expense.planned ? 1 : 0,
    expense_rate: record.expense.rate,
    expense_rule_id: record.expense.rule_id,
    source_refs_json: JSON.stringify(record.source_refs),
    source_updated_at: record.source_updated_at,
    synced_at: syncedAt,
  };
}

function fromStoredRow(row: StoredRow): SpendingLogRecord {
  return SpendingLogRecordSchema.parse({
    id: row.id,
    privacy_class: row.privacy_class,
    retention_scope: row.retention_scope,
    llm_relay_scope: row.llm_relay_scope,
    source_kind: row.source_kind,
    date: row.occurred_on,
    occurred_at: row.occurred_at,
    amount: row.amount,
    currency: row.currency,
    place: {
      name: row.place_name,
      google_place_id: row.google_place_id,
      google_maps_url: row.google_maps_url,
      location: row.latitude !== null && row.longitude !== null ? {
        latitude: row.latitude,
        longitude: row.longitude,
        accuracy_m: row.accuracy_m,
      } : null,
    },
    payment: parseJson(row.payment_json),
    items: parseJson(row.items_json),
    purchase_category: row.purchase_category,
    expense: {
      planned: row.expense_planned === null ? null : row.expense_planned === 1,
      rate: row.expense_rate,
      rule_id: row.expense_rule_id,
    },
    source_refs: parseJson(row.source_refs_json),
    source_updated_at: row.source_updated_at,
  });
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
