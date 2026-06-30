// ユーザーアプリ (プラグイン) を Memoria 本体プロセスに in-process マウントする。
//
// プラグイン実体は git submodule `server/plugins/memoria-plugin` (= LUDIARS/MemoriaPlugin)。
// 旧サイドカー (別プロセス / port 5191 / URL 接続 + iframe) は廃止し、 本体の Hono に
// 直接マウントする (Concordia の RWF submodule と同じ in-process 方式)。
//  - ルート: 各プラグインを /plugins/<id> に載せる (同一オリジン)。
//  - 機能: Discord通知 / GPS / 日記出力 / 傾向出力 を framework-store 経由で結線。
//  - 設定: <dataDir>/plugins/<id>.json (secret 含む、 per-user、 gitignore 前提)。
//  - DB:   プラグインは "plugin_<id>_*" テーブルを自由スキーマで read/write、 他は read-only。
//
// プラグイン置き場 (submodule 化でパス固定 → env 解決はやめ固定パス):
//  - 同梱: submodule の plugins/ (public 共有プラグイン)。
//  - 個人: 隣接リポ MemoriaPlugin-Local/plugins (public submodule に含めない個人用)。
//    同 id は個人が上書きする。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { loadPlugins } from './memoria-plugin/host/loader.js';
import { mountPlugins, type PluginRegistry } from './memoria-plugin/host/registry.js';
import type { PluginManifestEntry } from './memoria-plugin/host/types.js';
import { ensureFrameworkTables, createCapabilityProviders } from './framework-store.js';

type Db = BetterSqlite3.Database;

const HERE = dirname(fileURLToPath(import.meta.url)); // server/plugins
/** submodule 同梱の共有プラグイン置き場。 */
const BUNDLED_PLUGINS_DIR = join(HERE, 'memoria-plugin', 'plugins');
/** Memoria リポルート。 */
const REPO_ROOT = join(HERE, '..', '..');
/** 個人用ローカルプラグイン (public submodule に含めない)。 submodule 化でパス固定。 */
const LOCAL_PLUGINS_DIR = join(REPO_ROOT, '..', 'MemoriaPlugin-Local', 'plugins');

export interface MountUserAppsOptions {
  db: Db;
  /** 本体 DATA_DIR。 プラグイン設定は <dataDir>/plugins/<id>.json に置く。 */
  dataDir: string;
}

export interface MountUserAppsResult {
  manifest: PluginManifestEntry[];
  /** 単体ホットリロード等のための registry。 */
  registry: PluginRegistry;
}

/**
 * 同梱 + 個人ローカルのプラグインを読み込み、 本体 app に /plugins/<id> でマウントする。
 * manifest (相対 url) と registry を返す → /api/plugins / reload で UI に渡す。
 */
export async function mountUserApps(
  app: Hono,
  opts: MountUserAppsOptions,
): Promise<MountUserAppsResult> {
  const { db, dataDir } = opts;
  ensureFrameworkTables(db);
  // 同梱 (低優先) → 個人ローカル (高優先) の順。 同 id は個人が上書き。
  const loaded = await loadPlugins([BUNDLED_PLUGINS_DIR, LOCAL_PLUGINS_DIR]);
  // publicBaseUrl 省略 → manifest url は /plugins/<id> の相対 (同一オリジン iframe 用)。
  const { manifest, registry } = await mountPlugins(app, loaded, {
    dataDir: join(dataDir, 'plugins'),
    sqlite: db,
    capabilities: createCapabilityProviders(db),
  });
  return { manifest, registry };
}
