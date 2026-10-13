// 実行時に読み込む外部 TypeScript (プラグインの plugin.ts、Concordia spawn module など) の loader。
//
// bundle 済みの dist/server.js は tsx CLI を経由せずに起動するので、`.ts` を
// `await import()` するには TypeScript loader を別途入れる必要がある。tsx の ESM API
// (`tsx/esm/api` の register) は同じ node プロセス内に loader hook を足すだけで、
// tsx CLI のような子 node は立てない。ソース実行 (tsx 経由) では既に loader があるので何もしない。

import { IS_COMPILED } from './runtime-paths.js';

let registered: Promise<void> | null = null;

export interface ExternalTsLoaderDeps {
  compiled?: boolean;
  register?: () => Promise<void>;
}

async function registerTsx(): Promise<void> {
  const { register } = await import('tsx/esm/api');
  register();
}

/** 外部 `.ts` を import できる状態にする (何度呼んでも登録は 1 回)。 */
export function ensureExternalTsLoader(deps: ExternalTsLoaderDeps = {}): Promise<void> {
  if (!(deps.compiled ?? IS_COMPILED)) return Promise.resolve();
  registered ??= (deps.register ?? registerTsx)();
  return registered;
}

/** テスト用: 登録状態を戻す。 */
export function resetExternalTsLoaderForTest(): void {
  registered = null;
}
