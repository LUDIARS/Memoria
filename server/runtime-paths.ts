// Memoria server の実行時パス解決。
//
// 常駐の memoria-server は事前コンパイルした `dist/server.js` (1 ファイルへ bundle) で
// 起動する (tsx を常駐させない、neco 2026-10-12 / AIFormat RULE_TECH_STACK.md)。
// bundle 後は全モジュールの `import.meta.url` が `server/dist/server.js` を指すので、
// ソース基準のパス (data/ / plugins/ / mcp-server/) は必ずここで server/ に戻してから組む。
// tsx でソースを直接読む経路 (テスト・一回限りの CLI) では自身の場所 (= server/) を使う。
//
// このファイルは server/ 直下に置く。ソース実行時は自身の dir がそのまま server/ になる。

import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILD_DIR = 'dist';

/** `<dir>/dist/x.js` として読み込まれたか (= 事前コンパイル版で起動したか)。 */
export function isCompiledModule(moduleUrl: string): boolean {
  const here = dirname(fileURLToPath(moduleUrl));
  return moduleUrl.endsWith('.js') && basename(here) === BUILD_DIR;
}

/** モジュールのコンパイル前ディレクトリ (`<dir>/dist/x.js` なら `<dir>`)。 */
export function sourceDirOf(moduleUrl: string): string {
  const here = dirname(fileURLToPath(moduleUrl));
  return isCompiledModule(moduleUrl) ? resolve(here, '..') : here;
}

/** 事前コンパイル版で動いているか。 */
export const IS_COMPILED = isCompiledModule(import.meta.url);

/** Memoria の server/ ディレクトリ (ソース・dist どちらで起動しても同じ)。 */
export const SERVER_DIR = sourceDirOf(import.meta.url);

/** Memoria リポジトリ root。 */
export const REPO_ROOT = resolve(SERVER_DIR, '..');
