// memoria-server を事前コンパイルする (tsx を常駐させない、neco 2026-10-12)。
//
//   node scripts/build-server.mjs            → dist/server.js
//
// bootstrap.ts を entry に自前ソースだけを 1 ファイルへ bundle する。node_modules の
// パッケージは bundle せず実行時に node_modules から読む (better-sqlite3 などネイティブ
// addon や CJS 依存をそのまま使うため)。splitting はしない: 全モジュールの
// `import.meta.url` が dist/server.js になり、runtime-paths.ts の dist → server/ 解決が
// 1 通りで済む。プラグイン (plugin.ts) は実行時に動的 import するので bundle に入らない。

import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ENTRY = 'bootstrap.ts';
export const OUTFILE = 'dist/server.js';

export function serverBuildOptions(root) {
  return {
    entryPoints: [resolve(root, ENTRY)],
    outfile: resolve(root, OUTFILE),
    bundle: true,
    splitting: false,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    packages: 'external',
    sourcemap: true,
    logLevel: 'warning',
  };
}

export async function buildServer({ root }) {
  rmSync(resolve(root, 'dist'), { recursive: true, force: true });
  await build(serverBuildOptions(root));
  return { outfile: resolve(root, OUTFILE) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { outfile } = await buildServer({ root });
  console.log(`[build-server] ${outfile}`);
}
