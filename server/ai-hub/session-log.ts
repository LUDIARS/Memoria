// ai-hub — session-log の読み取りを 1 箇所に隔離する。
// session-log はリポジトリ外の作業記録 (補助材料) なので、 読めなければ
// 静かに null を返す (例外を投げない / 機能を止めない)。
// Spec: spec/feature/ai-hub.md §物理ファイル参照

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** session-log の既定ディレクトリ。 env MEMORIA_SESSION_LOG_DIR で上書き可。 */
const DEFAULT_SESSION_LOG_DIR = 'E:/Document/Ars/session-logs';

function sessionLogDir(): string {
  return process.env.MEMORIA_SESSION_LOG_DIR || DEFAULT_SESSION_LOG_DIR;
}

/**
 * 指定日 (YYYY-MM-DD) の session-log を読む。 ファイルが無い / 読み取りに
 * 失敗した場合は null を返す (例外は投げない)。
 */
export function readSessionLog(dateStr: string): string | null {
  try {
    const path = join(sessionLogDir(), `${dateStr}.md`);
    if (!existsSync(path)) return null;
    const text = readFileSync(path, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}
