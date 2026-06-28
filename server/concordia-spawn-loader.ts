// concordia-spawn-loader.ts — Concordia の spawn/inject 実装を「host URL を叩く」 代わりに
// **設定で指定したフォルダ/ファイルパスから動的 import** して取得する。
//
// 背景: 旧来は agent-dispatch が http://127.0.0.1:17330 (host URL) を叩いて Concordia の
// /v1/spawn を呼んでいた。 host URL は環境次第で存在しないため、 Concordia の実装モジュールを
// フォルダから動的にロードして in-process で呼ぶ方式へ寄せる (パスは設定 llm.concordia.module_path)。
//
// 契約: 指定モジュールは `createConcordiaSpawn(options?)` を export し、 ConcordiaSpawnApi
// ({ spawn, waitForSession, inject }) を返すこと (default export の factory も可)。
// 無言フォールバックはしない — 未設定 / import 失敗 / 契約違反はすべて明示 Error を投げる。

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ConcordiaSpawnApi } from './concordia-spawn-client.js';

export interface LoadConcordiaSpawnOptions {
  /** モジュール factory に渡すオプション (timeout 等、 モジュール側の解釈)。 */
  factoryOptions?: unknown;
  /** test seam: 動的 import を差し替える。 既定は実 import()。 */
  importImpl?: (specifier: string) => Promise<Record<string, unknown>>;
}

/** factory が満たすべきシグネチャ。 */
type ConcordiaSpawnFactory = (options?: unknown) => ConcordiaSpawnApi | Promise<ConcordiaSpawnApi>;

function pickFactory(mod: Record<string, unknown>): ConcordiaSpawnFactory | null {
  if (typeof mod.createConcordiaSpawn === 'function') return mod.createConcordiaSpawn as ConcordiaSpawnFactory;
  const def = mod.default as Record<string, unknown> | undefined;
  if (def && typeof def === 'object' && typeof def.createConcordiaSpawn === 'function') {
    return def.createConcordiaSpawn as ConcordiaSpawnFactory;
  }
  if (typeof mod.default === 'function') return mod.default as ConcordiaSpawnFactory;
  return null;
}

function assertSpawnApi(api: unknown, modulePath: string): asserts api is ConcordiaSpawnApi {
  const o = api as Partial<ConcordiaSpawnApi> | null;
  if (!o || typeof o.spawn !== 'function' || typeof o.waitForSession !== 'function' || typeof o.inject !== 'function') {
    throw new Error(
      `Concordia spawn module "${modulePath}" factory must return { spawn, waitForSession, inject }.`,
    );
  }
}

/**
 * 設定パスの Concordia モジュールを動的 import し、 ConcordiaSpawnApi を返す。
 * 失敗時は必ず Error を throw する (silent fallback 禁止)。
 */
export async function loadConcordiaSpawn(
  modulePath: string,
  opts: LoadConcordiaSpawnOptions = {},
): Promise<ConcordiaSpawnApi> {
  const path = (modulePath ?? '').trim();
  if (!path) {
    throw new Error(
      'Concordia spawn module path is not configured. Set setting "llm.concordia.module_path" to the Concordia spawn module file.',
    );
  }
  // test seam を渡されたときは specifier をそのまま、 実 import のときは file URL に解決。
  const specifier = opts.importImpl ? path : pathToFileURL(resolve(path)).href;
  const doImport = opts.importImpl ?? ((s: string) => import(s) as Promise<Record<string, unknown>>);

  let mod: Record<string, unknown>;
  try {
    mod = await doImport(specifier);
  } catch (e) {
    throw new Error(`failed to import Concordia spawn module "${path}": ${(e as Error).message}`);
  }

  const factory = pickFactory(mod);
  if (!factory) {
    throw new Error(
      `Concordia spawn module "${path}" must export createConcordiaSpawn(options) (or a default factory).`,
    );
  }

  const api = await factory(opts.factoryOptions);
  assertSpawnApi(api, path);
  return api;
}
