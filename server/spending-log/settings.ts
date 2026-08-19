import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

/**
 * 消費傾向助言の設定だけを読み書きする。 既定は「同意なし」で、 同意を明示しない限り
 * 助言機能は動かない (relay-policy.ts の昇格条件)。
 */
const SPENDING_ADVICE_SETTING_KEYS = {
  consent: 'spending_advice.consent',
  baseUrl: 'spending_advice.local_llm_base_url',
  model: 'spending_advice.local_llm_model',
} as const;

/** Ollama の OpenAI 互換エンドポイント。 loopback 以外は local-llm.ts が入口で弾く。 */
const DEFAULT_LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434/v1';
const DEFAULT_LOCAL_LLM_MODEL = 'gemma4:12b';

export interface SpendingAdviceSettings {
  consent: boolean;
  base_url: string;
  model: string;
}

export function readSpendingAdviceSettings(db: Db): SpendingAdviceSettings {
  return {
    consent: readSetting(db, SPENDING_ADVICE_SETTING_KEYS.consent) === '1',
    base_url: readSetting(db, SPENDING_ADVICE_SETTING_KEYS.baseUrl) ?? DEFAULT_LOCAL_LLM_BASE_URL,
    model: readSetting(db, SPENDING_ADVICE_SETTING_KEYS.model) ?? DEFAULT_LOCAL_LLM_MODEL,
  };
}

export interface SpendingAdviceSettingsPatch {
  consent?: boolean;
  base_url?: string;
  model?: string;
}

export function writeSpendingAdviceSettings(db: Db, patch: SpendingAdviceSettingsPatch): SpendingAdviceSettings {
  db.transaction(() => {
    if (patch.consent !== undefined) {
      writeSetting(db, SPENDING_ADVICE_SETTING_KEYS.consent, patch.consent ? '1' : '0');
    }
    if (patch.base_url !== undefined) writeSetting(db, SPENDING_ADVICE_SETTING_KEYS.baseUrl, patch.base_url);
    if (patch.model !== undefined) writeSetting(db, SPENDING_ADVICE_SETTING_KEYS.model, patch.model);
  })();
  return readSpendingAdviceSettings(db);
}

function readSetting(db: Db, key: string): string | null {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as
    { value: string | null } | undefined;
  return row?.value ?? null;
}

function writeSetting(db: Db, key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
