/**
 * OwnTracks subscriber 専用 process。
 *
 * Memoria のメイン server (index.js) とは別 process で動かし、 MQTT から
 * 受けた位置情報を Memoria の SQLite DB へ insert する。
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

interface InsertResult {
  id?: number;
  skipped?: boolean;
}

function main(): void {
  const config = loadOwntracksConfig();
  const dbPath = resolvePath(__dirname, '..', config.dbPath.replace(/^\.\//, ''));
  console.log(`[owntracks] starting (user_id=${config.userId}, db=${dbPath})`);

  const db = openDb(dbPath);

  const client = startOwntracksClient(config, async (topic, loc, ctx) => {
    const rec = locationToDbRecord(topic, loc, {
      userId: config.userId,
      rawJson: ctx.rawJson,
    });
    const result = insertGpsLocation(db, rec) as InsertResult;
    if (!result.skipped) {
      console.log(
        `[owntracks] insert id=${result.id} ${rec.deviceId ?? '?'} ` +
        `(${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}) tst=${rec.tst}`,
      );
    }
  });

  function shutdown(signal: string): void {
    console.log(`[owntracks] received ${signal}, shutting down`);
    client.end(false, {}, () => {
      try {
        db.close();
      } catch { /* ignore */ }
      process.exit(0);
    });
  }
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
