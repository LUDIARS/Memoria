/**
 * OwnTracks subscriber の設定。 環境変数から読み出す。
 *
 * Memoria は単一ユーザを前提とする個人用ツールなので、Iv (Imperativus) の
 * userMapping (OwnTracks user → Cernere user_id) は使わず、`MEMORIA_USER_ID`
 * (既定 'me') を全レコードに付ける。
 */

/**
 * @returns {OwntracksConfig}
 */
export function loadOwntracksConfig(env = process.env) {
  return {
    mqtt: {
      url:      env.MEMORIA_MQTT_URL      ?? 'mqtt://localhost:1884',
      username: env.MEMORIA_MQTT_USERNAME ?? '',
      password: env.MEMORIA_MQTT_PASSWORD ?? '',
      topic:    env.MEMORIA_MQTT_TOPIC    ?? 'owntracks/+/+',
      clientId: env.MEMORIA_MQTT_CLIENT_ID ?? `memoria-owntracks-${process.pid}`,
    },
    /** 単一ユーザ前提。multi-tenant 化したくなったら mapping を導入する。 */
    userId: env.MEMORIA_USER_ID ?? 'me',
    /** SQLite path。server/index.js と同じ既定を使う。 */
    dbPath: env.MEMORIA_DB_PATH ?? './data/memoria.db',
  };
}

/**
 * @typedef {Object} OwntracksConfig
 * @property {{ url: string, username: string, password: string, topic: string, clientId: string }} mqtt
 * @property {string} userId
 * @property {string} dbPath
 */
