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
// 保存形式は 2 系統を双方向に同期する:
//   (A) .infisical-creds.json  — Hub の GET / setup フォーム経由の歴史的形式
//   (B) .env.secrets           — env-cli (Cernere/Actio 互換) の形式 (KEY=value)
// 読み込みはどちらか存在する方から、 書き込みは両方を更新する。 これで:
//   - GET / で入れた値が `npm run env:setup` の既存値として表示される
//   - `npm run env:setup` で入れた値で Hub bootstrap が起動できる
// MEMORIA_HUB_CREDS_PATH で .json 側の場所を上書き可、 .env.secrets は同じ dir。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const CREDS_PATH = process.env.MEMORIA_HUB_CREDS_PATH
  || join(__dirname, '.infisical-creds.json');

/** env-cli 互換の .env.secrets パス (.infisical-creds.json と同じ dir)。 */
const ENV_SECRETS_PATH = join(dirname(CREDS_PATH), '.env.secrets');

/** .env 形式の text を key→value に parse (env-cli の parseEnvFile と同じ仕様)。 */
function parseEnvSecrets(content) {
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readFromJson() {
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

function readFromEnvSecrets() {
  if (!existsSync(ENV_SECRETS_PATH)) return null;
  try {
    const vars = parseEnvSecrets(readFileSync(ENV_SECRETS_PATH, 'utf8'));
    if (vars.INFISICAL_PROJECT_ID && vars.INFISICAL_CLIENT_ID && vars.INFISICAL_CLIENT_SECRET) {
      return {
        siteUrl: vars.INFISICAL_SITE_URL || 'https://app.infisical.com',
        projectId: vars.INFISICAL_PROJECT_ID,
        environment: vars.INFISICAL_ENVIRONMENT || 'prod',
        clientId: vars.INFISICAL_CLIENT_ID,
        clientSecret: vars.INFISICAL_CLIENT_SECRET,
      };
    }
  } catch (err) {
    console.warn(`[creds-store] ${ENV_SECRETS_PATH} 読込失敗: ${err.message}`);
  }
  return null;
}

/**
 * .infisical-creds.json (JSON) と .env.secrets (env-cli 形式) の両方を試す。
 * .env.secrets を優先する理由:
 *   - Hub の writeCreds は常に両方を atomic に書く (= 両方存在するときは同期済)
 *   - 一方 env-cli は .env.secrets だけを書く (= .json は stale 化しうる)
 *   - よって .env.secrets を信頼すれば「env-cli で更新した値が次回起動で効く」
 *     経路が壊れない。 .json は env-cli 不使用環境用 fallback として残置。
 *
 * @returns {{siteUrl,projectId,environment,clientId,clientSecret}|null}
 */
export function readCreds() {
  return readFromEnvSecrets() ?? readFromJson();
}

/**
 * creds を両方の形式で永続化する (= GET / フォームと env-cli setup の
 * どちらを使っても、 もう一方が次回起動時にそれを拾える)。
 */
export function writeCreds(creds) {
  const normalized = {
    siteUrl: creds.siteUrl,
    projectId: creds.projectId,
    environment: creds.environment || 'prod',
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  };
  writeFileSync(CREDS_PATH, JSON.stringify(normalized, null, 2),
    { encoding: 'utf8', mode: 0o600 });
  const envContent = [
    '# ─── Infisical Bootstrap Credentials ─────────────────────────',
    '# Memoria Hub / GET / setup フォーム または env-cli setup で自動生成。',
    '# このファイルは .gitignore に含めること。',
    '# ─────────────────────────────────────────────────────────────',
    '',
    `INFISICAL_SITE_URL=${normalized.siteUrl}`,
    `INFISICAL_PROJECT_ID=${normalized.projectId}`,
    `INFISICAL_ENVIRONMENT=${normalized.environment}`,
    `INFISICAL_CLIENT_ID=${normalized.clientId}`,
    `INFISICAL_CLIENT_SECRET=${normalized.clientSecret}`,
    '',
  ].join('\n');
  writeFileSync(ENV_SECRETS_PATH, envContent,
    { encoding: 'utf8', mode: 0o600 });
}
