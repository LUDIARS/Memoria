/**
 * bootstrap entry — `.env` ファイル無し運用の起動口。 LUDIARS/Cernere#79 と同パターン。
 *
 * `npm start` / `npm run dev` は `tsx bootstrap.ts`。
 *   1. SQLite app_settings から machine identity (infisical.*) を読んで env に載せる
 *      (= 専用セットアップ画面で入力された分。 Excubitor / host env が既にあればそちら優先)
 *   2. ensureEnv() が Infisical からアプリ設定値を fetch して inject
 *   3. index.js を import して本体起動
 *
 * machine identity がどこにも無い場合でも起動は止めない。 index.ts 側の
 * setup gate middleware が全 route より前段で専用セットアップ画面を出す。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { ensureEnv, INFISICAL_SETTING_KEYS } from './lib/env-bootstrap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_SECRETS_PATH = resolve(__dirname, '.env.secrets');

/**
 * SQLite app_settings から `infisical.*` を読んで process.env に注入。
 * 専用セットアップ画面で入力された machine identity を起動時に拾うため。
 * 既に env にある値 (Excubitor inject / host shell) は上書きしない。
 */
function loadCredsFromDb(): void {
  // index.ts と同じ解決ルール: MEMORIA_DATA env、 無ければ server/../data。
  const dataDir = resolve(process.env.MEMORIA_DATA ?? join(__dirname, '..', 'data'));
  const dbPath = join(dataDir, 'memoria.db');
  if (!existsSync(dbPath)) return;
  try {
    // better-sqlite3 は同期。 bootstrap でだけ readonly で開いて即閉じる。
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare(
        `SELECT key, value FROM app_settings WHERE key LIKE 'infisical.%'`,
      ).all() as Array<{ key: string; value: string | null }>;
      const dbCreds: Record<string, string> = {};
      for (const { key, value } of rows) {
        const envName = (INFISICAL_SETTING_KEYS as Record<string, string>)[key];
        if (envName && value) {
          dbCreds[envName] = value;
          if (!process.env[envName]) process.env[envName] = value;
        }
      }
      // 既存ユーザの one-shot migration: SQLite に creds があるのに .env.secrets が
      // 無ければ書き出す。 これで `npm run env:setup` / `env:gen` が UI 入力分を拾える
      // (双方向同期、 setup フォーム → .env.secrets / env-cli → .env.secrets)。
      if (!existsSync(ENV_SECRETS_PATH)
          && dbCreds.INFISICAL_PROJECT_ID
          && dbCreds.INFISICAL_CLIENT_ID
          && dbCreds.INFISICAL_CLIENT_SECRET) {
        try {
          writeEnvSecretsFromMap(dbCreds);
          console.log(`[bootstrap] .env.secrets を SQLite app_settings から自動生成 (env-cli 連携)`);
        } catch (err) {
          console.warn(`[bootstrap] .env.secrets 自動生成失敗: ${(err as Error).message}`);
        }
      }
    } finally {
      db.close();
    }
  } catch (err) {
    // テーブル未作成 (初回起動) 等は無視 — setup gate に任せる。
    console.warn(`[bootstrap] app_settings 読込スキップ: ${(err as Error).message}`);
  }
}

/** env-cli の saveBootstrap と同じ形式で .env.secrets を書く (one-shot migration 用)。 */
function writeEnvSecretsFromMap(env: Record<string, string>): void {
  const content = [
    '# ─── Infisical Bootstrap Credentials ─────────────────────────',
    '# Memoria local bootstrap が SQLite app_settings から自動生成。',
    '# 以後は setup UI / env-cli setup どちらの更新でも両方が更新される。',
    '# ─────────────────────────────────────────────────────────────',
    '',
    `INFISICAL_SITE_URL=${env.INFISICAL_SITE_URL || ''}`,
    `INFISICAL_PROJECT_ID=${env.INFISICAL_PROJECT_ID}`,
    `INFISICAL_ENVIRONMENT=${env.INFISICAL_ENVIRONMENT || 'dev'}`,
    `INFISICAL_CLIENT_ID=${env.INFISICAL_CLIENT_ID}`,
    `INFISICAL_CLIENT_SECRET=${env.INFISICAL_CLIENT_SECRET}`,
    '',
  ].join('\n');
  writeFileSync(ENV_SECRETS_PATH, content, { encoding: 'utf8', mode: 0o600 });
}

async function bootstrap(): Promise<void> {
  loadCredsFromDb();
  try {
    await ensureEnv();
  } catch (err) {
    // ensureEnv は throw しない設計だが、 想定外は log だけ出して継続。
    console.error(`[bootstrap] ${(err as Error).message}`);
  }
  await import('./index.js');
}

void bootstrap();
