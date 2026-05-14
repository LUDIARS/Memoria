// bootstrap — Hub の起動エントリ。
//
// index.js を import する前に:
//   1. Postgres の app_settings から Infisical machine identity (infisical.*)
//      を読んで process.env に載せる (= GET / の設定フォームで入力された creds)。
//   2. ensureEnv() で Infisical からアプリ設定 (CERNERE_BASE_URL 等) を取得して
//      process.env に inject する。
//
// host env / Excubitor が既に INFISICAL_* を渡している場合はそちらが優先
// (injectSecrets / loadCredsFromDb とも既存 process.env を上書きしない)。
//
// MEMORIA_PG_URL だけは infra 値なので Docker compose / host env から渡る前提。

import { getAppSettings } from './db.js';
import { ensureEnv, INFISICAL_SETTING_KEYS, hasInfisicalCreds, missingWantedKeys } from './env-bootstrap.js';

async function loadCredsFromDb() {
  let settings;
  try {
    settings = await getAppSettings();
  } catch (err) {
    console.warn(`[bootstrap] app_settings 読込スキップ: ${err.message}`);
    return;
  }
  for (const [settingKey, envName] of Object.entries(INFISICAL_SETTING_KEYS)) {
    const v = settings[settingKey];
    if (v && !process.env[envName]) process.env[envName] = v;
  }
}

async function main() {
  if (!process.env.MEMORIA_PG_URL) {
    console.error('[bootstrap] MEMORIA_PG_URL is required');
    process.exit(1);
  }
  await loadCredsFromDb();
  await ensureEnv();
  if (!hasInfisicalCreds()) {
    console.warn('[bootstrap] Infisical 未設定 — GET / の設定フォームから入力してください');
  }
  const missing = missingWantedKeys();
  if (missing.length > 0) {
    console.warn(`[bootstrap] 未取得の設定キー: ${missing.join(', ')}`);
  }
  await import('./index.js');
}

main().catch((err) => {
  console.error('[bootstrap] fatal:', err);
  process.exit(1);
});
