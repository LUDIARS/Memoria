/**
 * bootstrap entry — Memoria Local は Infisical を使わない (= 全機能ローカル完結)。
 * 旧 Infisical bootstrap (machine identity 注入 + ensureEnv) は撤去された。
 *
 * Tabula連携の資格情報は環境変数で受け取る。
 *
 * `npm start` / `npm run dev` は `tsx bootstrap.ts`。 ここでは index.ts を import するだけ。
 */
async function bootstrap(): Promise<void> {
  await import('./index.js');
}

void bootstrap();
