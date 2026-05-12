/**
 * bootstrap entry — `.env` ファイル無し運用の起動口。 LUDIARS/Cernere#79 と同パターン。
 *
 * Memoria server は dev 起動 `npm run dev` → `tsx watch index.ts` だが、
 * Excubitor 経由 inject 運用へ移行する際は `tsx watch bootstrap.ts` に切り替える。
 * REQUIRED_KEYS が空のうちは ensureEnv は即 return するので動作に影響なし。
 */
import { ensureEnv } from './lib/env-bootstrap.js';

async function bootstrap(): Promise<void> {
  try {
    await ensureEnv();
  } catch (err) {
    console.error(`[bootstrap] ${(err as Error).message}`);
    process.exit(1);
  }
  await import('./index.js');
}

void bootstrap();
