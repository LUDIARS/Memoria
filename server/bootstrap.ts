/**
 * bootstrap entry — Memoria Local は Infisical を使わない (= 全機能ローカル完結)。
 * 旧 Infisical bootstrap (machine identity 注入 + ensureEnv) は撤去された。
 *
 * Tabula連携の資格情報は環境変数で受け取る。
 *
 * 常駐起動 (Excubitor) は `npm run build` で事前コンパイルした `dist/server.js` を
 * `node --env-file-if-exists=.env.secrets dist/server.js` で直接起動する。
 * `npm start` / `npm run dev` は `tsx bootstrap.ts` のまま。
 * dist 起動では実行時に読む外部 TypeScript (プラグイン等) のため loader を先に入れる。
 */
import { ensureExternalTsLoader } from './external-ts-loader.js';

async function bootstrap(): Promise<void> {
  await ensureExternalTsLoader();
  await import('./index.js');
}

void bootstrap().catch((error: unknown) => {
  console.error('[bootstrap] fatal:', error);
  process.exitCode = 1;
});
