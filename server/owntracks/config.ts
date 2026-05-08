/**
 * OwnTracks subscriber の設定。 環境変数から読み出す。
 *
 * Memoria は単一ユーザを前提とする個人用ツールなので、Iv (Imperativus) の
 * userMapping (OwnTracks user → Cernere user_id) は使わず、`MEMORIA_USER_ID`
 * (既定 'me') を全レコードに付ける。
 */

export interface OwntracksConfig {
  mqtt: {
    url: string;
    username: string;
    password: string;
    topic: string;
    clientId: string;
  };
  /** 単一ユーザ前提。 multi-tenant 化したくなったら mapping を導入する。 */
  userId: string;
  /** SQLite path。 server/index.js と同じ既定を使う。 */
  dbPath: string;
}

export function loadOwntracksConfig(env: NodeJS.ProcessEnv = process.env): OwntracksConfig {
  return {
    mqtt: {
      url:      env.MEMORIA_MQTT_URL      ?? 'mqtt://localhost:1884',
      username: env.MEMORIA_MQTT_USERNAME ?? '',
      password: env.MEMORIA_MQTT_PASSWORD ?? '',
      topic:    env.MEMORIA_MQTT_TOPIC    ?? 'owntracks/+/+',
      clientId: env.MEMORIA_MQTT_CLIENT_ID ?? `memoria-owntracks-${process.pid}`,
    },
    userId: env.MEMORIA_USER_ID ?? 'me',
    dbPath: env.MEMORIA_DB_PATH ?? './data/memoria.db',
  };
}
