/**
 * bootstrap entry — `.env` ファイル無し運用の起動口。 LUDIARS/Cernere#79 と同パターン。
 *
 * `npm start` / `npm run dev` は `tsx --env-file-if-exists=.env.secrets bootstrap.ts`。
 *   1. tsx が `.env.secrets` (= Infisical machine identity) を process.env に読む
 *   2. ensureEnv() が Infisical からアプリ設定値を fetch して inject
 *   3. index.js を import して本体起動
 *
 * ensureEnv は Infisical 到達失敗でも throw しない (= ローカル個人開発を止めない)
 * 設計なので、 ここで catch しても基本 process.exit には至らない。
 */
import { ensureEnv } from './lib/env-bootstrap.js';

async function bootstrap(): Promise<void> {
  try {
    await ensureEnv();
  } catch (err) {
    // ensureEnv は基本 throw しないが、 想定外エラーは log だけ出して継続。
    console.error(`[bootstrap] ${(err as Error).message}`);
  }
  await import('./index.js');
}

void bootstrap();
