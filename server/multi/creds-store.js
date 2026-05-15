// creds-store — Hub の Infisical machine identity をローカルファイルで持つ。
//
// なぜ Postgres ではなくファイルか:
//   Hub は MEMORIA_PG_URL すら Infisical から取得する設計 (= Infra 系の値も
//   含め全部 Infisical 本体に置く)。 すると「Infisical creds を Postgres に
//   保存」 は循環依存になる (PG に繋ぐには PG_URL が要り、 PG_URL を得るには
//   Infisical が要り、 Infisical creds は PG に入っている…)。
//   なので machine identity だけはファイルで持つ。 Local backend の
//   .env.secrets / SQLite app_settings に対応する Hub 版。
//
// 保存場所は既定で server/multi/.infisical-creds.json (gitignore 済)。
// MEMORIA_HUB_CREDS_PATH で上書き可。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const CREDS_PATH = process.env.MEMORIA_HUB_CREDS_PATH
  || join(__dirname, '.infisical-creds.json');

/** @returns {{siteUrl,projectId,environment,clientId,clientSecret}|null} */
export function readCreds() {
  if (!existsSync(CREDS_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
    if (raw && raw.siteUrl && raw.projectId && raw.clientId && raw.clientSecret) {
      return {
        siteUrl: String(raw.siteUrl),
        projectId: String(raw.projectId),
        environment: String(raw.environment || 'prod'),
        clientId: String(raw.clientId),
        clientSecret: String(raw.clientSecret),
      };
    }
  } catch (err) {
    console.warn(`[creds-store] ${CREDS_PATH} 読込失敗: ${err.message}`);
  }
  return null;
}

export function writeCreds(creds) {
  writeFileSync(
    CREDS_PATH,
    JSON.stringify({
      siteUrl: creds.siteUrl,
      projectId: creds.projectId,
      environment: creds.environment || 'prod',
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );
}
