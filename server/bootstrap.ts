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
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { ensureEnv, INFISICAL_SETTING_KEYS } from './lib/env-bootstrap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
      for (const { key, value } of rows) {
        const envName = (INFISICAL_SETTING_KEYS as Record<string, string>)[key];
        if (envName && value && !process.env[envName]) {
          process.env[envName] = value;
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
