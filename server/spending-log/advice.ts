import type BetterSqlite3 from 'better-sqlite3';
import { analyzeSpending, type SpendingAnalytics, type AnalyzeRange } from './analytics.js';
import { SPENDING_ADVICE_SYSTEM_PROMPT, buildSpendingAdvicePrompt } from './advice-prompt.js';
import type { SpendingLogRecord } from './contract.js';
import { runLocalLlm, type LocalLlmResult } from './local-llm.js';
import { allowsSpendingAdviceRelay, SPENDING_ADVICE_SCOPE } from './relay-policy.js';
import { readSpendingAdviceSettings } from './settings.js';
import { listSpendingLogs } from './store.js';

type Db = BetterSqlite3.Database;

/**
 * 消費傾向の助言を 1 本生成して保存するところまでを受け持つ。 集計 (analytics.ts)、
 * プロンプト整形 (advice-prompt.ts)、 LLM 送信 (local-llm.ts) は各モジュールに委ね、
 * ここは同意チェックと順序、 保存だけを持つ。
 */

export class SpendingAdviceConsentError extends Error {}

export interface GenerateAdviceInput {
  db: Db;
  range: AnalyzeRange;
  currency: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface SpendingAdviceReport {
  id: number;
  date_from: string;
  date_to: string;
  currency: string;
  provider_label: string;
  model: string;
  analytics: SpendingAnalytics;
  advice_markdown: string;
  record_count: number;
  generated_at: string;
}

export async function generateSpendingAdvice(input: GenerateAdviceInput): Promise<SpendingAdviceReport> {
  const settings = readSpendingAdviceSettings(input.db);
  if (!settings.consent) {
    throw new SpendingAdviceConsentError(
      '消費傾向の LLM 分析は未同意です (spending_advice.consent を有効にしてください)',
    );
  }

  // 同意済みでも、 実際に scope が昇格している行だけを入力にする。 同期前の行や
  // 同意取り消し後に残った行を取りこぼしなく除外するため、 scope そのもので絞る。
  const records: SpendingLogRecord[] = listSpendingLogs(input.db, {
    dateFrom: input.range.dateFrom,
    dateTo: input.range.dateTo,
    relayScope: SPENDING_ADVICE_SCOPE,
  }).filter((record) => allowsSpendingAdviceRelay(record.llm_relay_scope));

  if (records.length === 0) {
    throw new Error('対象期間に助言へ渡せる支出ログがありません');
  }

  const analytics = analyzeSpending(records, input.currency, input.range);
  if (analytics.record_count === 0) {
    throw new Error(`対象期間に ${input.currency} の支出ログがありません`);
  }

  const result: LocalLlmResult = await runLocalLlm({
    baseUrl: settings.base_url,
    model: settings.model,
    systemPrompt: SPENDING_ADVICE_SYSTEM_PROMPT,
    userPrompt: buildSpendingAdvicePrompt(analytics),
    fetchImpl: input.fetchImpl,
  });

  const generatedAt = (input.now?.() ?? new Date()).toISOString();
  const id = insertReport(input.db, {
    analytics,
    adviceMarkdown: result.text,
    providerLabel: result.provider_label,
    model: result.model,
    generatedAt,
  });

  return {
    id,
    date_from: analytics.date_from,
    date_to: analytics.date_to,
    currency: analytics.currency,
    provider_label: result.provider_label,
    model: result.model,
    analytics,
    advice_markdown: result.text,
    record_count: analytics.record_count,
    generated_at: generatedAt,
  };
}

export function listSpendingAdviceReports(db: Db, limit = 20): SpendingAdviceReport[] {
  const rows = db.prepare(`
    SELECT id, date_from, date_to, currency, provider_label, model,
           analytics_json, advice_markdown, record_count, generated_at
      FROM spending_advice_reports
     ORDER BY generated_at DESC, id DESC
     LIMIT ?
  `).all(limit) as Array<{
    id: number;
    date_from: string;
    date_to: string;
    currency: string;
    provider_label: string;
    model: string;
    analytics_json: string;
    advice_markdown: string;
    record_count: number;
    generated_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    date_from: row.date_from,
    date_to: row.date_to,
    currency: row.currency,
    provider_label: row.provider_label,
    model: row.model,
    analytics: JSON.parse(row.analytics_json) as SpendingAnalytics,
    advice_markdown: row.advice_markdown,
    record_count: row.record_count,
    generated_at: row.generated_at,
  }));
}

interface InsertReportInput {
  analytics: SpendingAnalytics;
  adviceMarkdown: string;
  providerLabel: string;
  model: string;
  generatedAt: string;
}

function insertReport(db: Db, input: InsertReportInput): number {
  const info = db.prepare(`
    INSERT INTO spending_advice_reports (
      date_from, date_to, currency, provider_label, model,
      analytics_json, advice_markdown, record_count, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.analytics.date_from,
    input.analytics.date_to,
    input.analytics.currency,
    input.providerLabel,
    input.model,
    JSON.stringify(input.analytics),
    input.adviceMarkdown,
    input.analytics.record_count,
    input.generatedAt,
  );
  return Number(info.lastInsertRowid);
}
