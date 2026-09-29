import type BetterSqlite3 from 'better-sqlite3';
import { jstDate } from './jsonl.js';

type Db = BetterSqlite3.Database;

export interface InventorySnapshot {
  capturedAt: string;
  skillCount: number;
  memoryCount: number;
  geniusCardCount: number | null;
  judgmentLogCount: number;
  localLlms: unknown[];
  sourceErrors: string[];
}

export function saveInventorySnapshot(db: Db, snapshot: InventorySnapshot): void {
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
    jstDate(new Date(snapshot.capturedAt)), snapshot.capturedAt,
    snapshot.skillCount, snapshot.memoryCount, snapshot.geniusCardCount,
    snapshot.judgmentLogCount, JSON.stringify(snapshot.localLlms), JSON.stringify(snapshot.sourceErrors),
  );
}

export function inventoryHistory(db: Db): Array<Record<string, unknown>> {
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
