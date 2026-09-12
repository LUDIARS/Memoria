import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * このプロセスが名乗る版。
 *
 * AIFormat `RULE_SRE.md` §2 は `/api/health` に `ok` / `service` / `version` を求める。
 * `version` は**ディスクに何が置かれているか**ではなく**このプロセスが何を読み込んで
 * 走っているか**なので、Excubitor が起動時に注入した値を最優先で採る。注入が無い直接
 * 起動のためにディスクの `package.json` へ落ちる。
 *
 * 版を名乗らないと、Excubitor もサービス版の横断照会 (Revisor service-version) も
 * 「走っている版」と「ディスクの版」を突き合わせられず、**反映したつもり**を検出できない。
 */

const UNKNOWN_VERSION = '0.0.0+unversioned';

function fromEnv(env: NodeJS.ProcessEnv): string | null {
  for (const key of ['EXCUBITOR_SERVICE_VERSION', 'MEMORIA_SERVICE_VERSION', 'npm_package_version']) {
    const value = (env[key] ?? '').trim();
    if (value) return value;
  }
  return null;
}

function fromManifest(): string | null {
  // desktop へ同梱された配置でも読めるよう、 自分の位置から上へ辿る。
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, 'package.json'),
    join(here, '..', 'package.json'),
    join(here, '..', '..', 'package.json'),
  ]) {
    try {
      const version = String(JSON.parse(readFileSync(candidate, 'utf8'))?.version ?? '').trim();
      if (version) return version;
    } catch {
      // この階層に package.json が無いだけ。次を見る。
    }
  }
  return null;
}

/** 常に文字列を返す。解決できなければ `0.0.0+unversioned`。 */
export function resolveServiceVersion(env: NodeJS.ProcessEnv = process.env): string {
  return fromEnv(env) ?? fromManifest() ?? UNKNOWN_VERSION;
}
