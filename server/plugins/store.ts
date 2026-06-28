// ユーザーアプリ (プラグインホスト) 接続設定の読み書き。
// app_settings に host URL と API トークンを持つ。 トークンはプラグイン → Memoria の
// announce 呼び出しを認可するための共有秘密。

import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';

type Db = BetterSqlite3.Database;

const HOST_URL = 'plugins.host_url';
const API_TOKEN = 'plugins.api_token';

export interface PluginHostConfig {
  hostUrl: string;
  apiToken: string;
}

export function getPluginHostConfig(db: Db): PluginHostConfig {
  const s = getAppSettings(db);
  return {
    hostUrl: typeof s[HOST_URL] === 'string' ? s[HOST_URL] : '',
    apiToken: typeof s[API_TOKEN] === 'string' ? s[API_TOKEN] : '',
  };
}

export function setPluginHostConfig(db: Db, patch: Partial<PluginHostConfig>): void {
  const values: Record<string, string> = {};
  if (patch.hostUrl !== undefined) values[HOST_URL] = patch.hostUrl.trim();
  if (patch.apiToken !== undefined) values[API_TOKEN] = patch.apiToken;
  setAppSettings(db, values);
}
