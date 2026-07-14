/**
 * bootstrap entry — Memoria Local は Infisical を使わない (= 全機能ローカル完結)。
 * 旧 Infisical bootstrap (machine identity 注入 + ensureEnv) は撤去された。
 *
 * Hub 連携が必要な場合は Memoria Hub (server/multi/) 側に Infisical 設定を持たせる
 * (= env-cli は server/multi/.env.secrets だけを扱う)。
 *
 * `npm start` / `npm run dev` は `tsx bootstrap.ts`。 ここでは index.ts を import するだけ。
 */
async function bootstrap(): Promise<void> {
  await import('./index.js');
}

void bootstrap();
