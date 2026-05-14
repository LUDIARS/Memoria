// bootstrap — Hub の起動エントリ。
//
// index.js を import する前に:
//   1. Infisical machine identity (INFISICAL_*) を host env、 無ければ creds
//      ファイル (= GET / の設定フォームで保存されたもの) から process.env に載せる。
//   2. ensureEnv() で Infisical から全アプリ設定 (MEMORIA_PG_URL /
//      CERNERE_BASE_URL 等) を取得して process.env に inject する。
//
// MEMORIA_PG_URL も Infisical 経由で来る (= Infra 系の値も Infisical に集約)。
// なので Postgres は ensureEnv() の後でないと繋げない。 Infisical 未設定でも
// 起動は止めない — GET / の設定フォームを出すため。

import { readCreds } from './creds-store.js';
import { ensureEnv, seedCredsFromObject, hasInfisicalCreds, missingWantedKeys } from './env-bootstrap.js';

async function main() {
  // 1. machine identity: host env に無ければ creds ファイルから
  if (!hasInfisicalCreds()) {
    const fileCreds = readCreds();
    if (fileCreds) seedCredsFromObject(fileCreds);
  }

  // 2. Infisical から全 secret (MEMORIA_PG_URL 含む) を取得
  await ensureEnv();

  if (!hasInfisicalCreds()) {
    console.warn('[bootstrap] Infisical 未設定 — GET / の設定フォームから入力してください');
  } else if (!process.env.MEMORIA_PG_URL) {
    console.warn('[bootstrap] Infisical 接続済だが MEMORIA_PG_URL が未取得 — Infisical project に用意してください');
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
