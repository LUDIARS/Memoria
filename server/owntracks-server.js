/**
 * OwnTracks subscriber 専用 process。
 *
 * Memoria のメイン server (index.js) とは別 process で動かし、 MQTT から
 * 受けた位置情報を Memoria の SQLite DB へ insert する。 HTTP サーバ機能は
 * 持たない (REST 経由の問い合わせは index.js の /api/locations が担当)。
 *
 * 起動: `npm run owntracks` (dev は `npm run owntracks:dev`)
 *
 * 環境変数:
 *   MEMORIA_MQTT_URL        既定 mqtt://localhost:1884 (Memoria 専有 broker)
 *   MEMORIA_MQTT_USERNAME   broker auth (任意)
 *   MEMORIA_MQTT_PASSWORD   broker auth (任意)
 *   MEMORIA_MQTT_TOPIC      既定 owntracks/+/+
 *   MEMORIA_MQTT_CLIENT_ID  client identifier (任意)
 *   MEMORIA_USER_ID         レコードに付ける user_id (既定 'me')
 *   MEMORIA_DB_PATH         SQLite path (既定 ./data/memoria.db)
 */

import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { openDb, insertGpsLocation } from './db.js';
import { loadOwntracksConfig } from './owntracks/config.js';
import { startOwntracksClient } from './owntracks/client.js';
import { locationToDbRecord } from './owntracks/payload.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function main() {
  const config = loadOwntracksConfig();
  const dbPath = resolvePath(__dirname, '..', config.dbPath.replace(/^\.\//, ''));
  console.log(`[owntracks] starting (user_id=${config.userId}, db=${dbPath})`);

  const db = openDb(dbPath);

  const client = startOwntracksClient(config, async (topic, loc, ctx) => {
    const rec = locationToDbRecord(topic, loc, {
      userId: config.userId,
      rawJson: ctx.rawJson,
    });
    const result = insertGpsLocation(db, rec);
    if (!result.skipped) {
      console.log(
        `[owntracks] insert id=${result.id} ${rec.deviceId ?? '?'} ` +
        `(${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}) tst=${rec.tst}`
      );
    }
  });

  function shutdown(signal) {
    console.log(`[owntracks] received ${signal}, shutting down`);
    client.end(false, {}, () => {
      try { db.close(); } catch {}
      process.exit(0);
    });
  }
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
