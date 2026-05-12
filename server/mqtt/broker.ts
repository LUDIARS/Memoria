// 内蔵 MQTT broker — aedes ベース。
//
// 設計:
//   - 別途 Mosquitto 等のインストールは不要。 Memoria server (index.ts) と
//     同 process で broker を起動する。
//   - モバイル (OwnTracks) は **Tailscale 等の VPN 経由** で publish する想定。
//     broker は loopback / tailnet IP のみ bind するのが既定。
//     publish された owntracks/<user>/<device> を即座に DB へ insert + /ws/locations
//     に broadcast する。
//   - Legatus 経由の OwnTracks → Memoria 中継は不要になるので、 index.ts では
//     既定で legatus subscriber を off にする。
//
// 認証:
//   MEMORIA_MQTT_USERNAME / MEMORIA_MQTT_PASSWORD が両方設定されていれば
//   一致するクライアントのみ受け付ける。 未設定なら all-allow (Tailscale で
//   閉じている前提)。 broker の bind を loopback / tailnet にしておけば
//   インターネットから到達できないので、 認証は補助レイヤー。
//
// 起動:
//   const broker = startMqttBroker({ db, broadcastLocation, triggerResolveAsync });
//   process.on('SIGTERM', () => broker.close());
//
// 環境変数:
//   MEMORIA_MQTT_BROKER          'off' で完全停止 (default: 起動)
//   MEMORIA_MQTT_BROKER_PORT     TCP port (default 1883)
//   MEMORIA_MQTT_BROKER_HOST     bind host (default '0.0.0.0' — tailnet/lo に限定したい場合は '127.0.0.1' 等)
//   MEMORIA_MQTT_USERNAME        publish 認証用 (任意)
//   MEMORIA_MQTT_PASSWORD        publish 認証用 (任意)
//   MEMORIA_MQTT_TOPIC           subscribe する topic (default 'owntracks/+/+')
//   MEMORIA_USER_ID              Memoria 側で gps 行に書く user_id (default 'me')

// aedes は CJS で `module.exports = Aedes (= createBroker)` のみ。 ESM 側からは
// named import で createBroker / AuthErrorCode を引けないので default import に
// 統一する。 型情報上 default は class (Aedes) として宣言されているため、
// 実行時の callable (= createBroker と同じ) 値として使うには cast が必要。
import AedesDefault from 'aedes';
import type { AedesPublishPacket, AuthenticateError, Client as AedesClient } from 'aedes';
// TS の `typeof import('aedes')` は class でも function でもない namespace 扱い
// になるため call signature を別途宣言する必要がある。 d.ts では
// `createBroker(opts?): Aedes` と宣言されているので、 戻り値は ReturnType で拾う。
type CreateBrokerFn = typeof import('aedes').createBroker;
const createBroker = AedesDefault as unknown as CreateBrokerFn;

// aedes は AuthErrorCode を `const enum` でしか export しないため
// tsx (isolatedModules) からは値として import できない。 MQTT 3.1.1 の
// CONNACK return code 4 = bad username / password をローカル定義する。
const AUTH_RC_BAD_USERNAME_OR_PASSWORD = 4 as const;
import { createServer as netCreateServer, type Server as NetServer } from 'node:net';
import type BetterSqlite3 from 'better-sqlite3';
import { insertGpsLocation } from '../db.js';
import { parseOwntracksLocation, parseOwntracksTopic, locationToDbRecord } from '../owntracks/payload.js';
import type { LocationBroadcastPoint } from '../lib/ws-locations.js';

type Db = BetterSqlite3.Database;

export interface MqttBrokerDeps {
  db: Db;
  broadcastLocation: (point: LocationBroadcastPoint) => void;
  triggerResolveAsync: (id: number, lat: number, lon: number) => void;
  /** Memoria の gps 行に書く user_id。 default 'me' */
  userId?: string;
}

export interface MqttBrokerHandle {
  port: number;
  host: string;
  close(): Promise<void>;
}

const DEFAULT_PORT = 1883;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_TOPIC = 'owntracks/+/+';

export function startMqttBroker(deps: MqttBrokerDeps): MqttBrokerHandle | null {
  const env = process.env;
  if (env.MEMORIA_MQTT_BROKER === 'off') return null;

  const port = Number(env.MEMORIA_MQTT_BROKER_PORT ?? DEFAULT_PORT);
  const host = env.MEMORIA_MQTT_BROKER_HOST ?? DEFAULT_HOST;
  const expectedUsername = env.MEMORIA_MQTT_USERNAME ?? '';
  const expectedPassword = env.MEMORIA_MQTT_PASSWORD ?? '';
  const topicMatch = env.MEMORIA_MQTT_TOPIC ?? DEFAULT_TOPIC;
  const userId = deps.userId ?? env.MEMORIA_USER_ID ?? 'me';

  const aedes = createBroker();

  if (expectedUsername || expectedPassword) {
    aedes.authenticate = (
      _client: AedesClient,
      username: Readonly<Buffer | string | undefined>,
      password: Readonly<Buffer | undefined>,
      done: (error: AuthenticateError | null, success: boolean) => void,
    ): void => {
      const u = typeof username === 'string' ? username : (username?.toString('utf8') ?? '');
      const p = password ? password.toString('utf8') : '';
      if (u === expectedUsername && p === expectedPassword) {
        done(null, true);
      } else {
        const err = Object.assign(new Error('bad credentials'), {
          returnCode: AUTH_RC_BAD_USERNAME_OR_PASSWORD,
        }) as AuthenticateError;
        done(err, false);
      }
    };
  }

  aedes.on('publish', (packet: AedesPublishPacket, client: AedesClient | null) => {
    if (!client) return; // broker 自身が publish するシステム topic は無視
    const topic = packet.topic;
    if (!topic || !topicLooksLikeOwntracks(topic, topicMatch)) return;

    const parsedTopic = parseOwntracksTopic(topic);
    if (!parsedTopic) return;

    let raw: unknown;
    let rawJson = '';
    try {
      rawJson = packet.payload.toString('utf8');
      raw = JSON.parse(rawJson);
    } catch {
      return;
    }

    const loc = parseOwntracksLocation(raw);
    if (!loc) return;

    const rec = locationToDbRecord(parsedTopic, loc, { userId, rawJson });
    let result;
    try {
      result = insertGpsLocation(deps.db, {
        userId: rec.userId,
        deviceId: rec.deviceId,
        tst: rec.tst,
        lat: rec.lat,
        lon: rec.lon,
        accuracy: rec.accuracy ?? null,
        altitude: rec.altitude ?? null,
        velocity: rec.velocity ?? null,
        course: rec.course ?? null,
        battery: rec.battery ?? null,
        conn: rec.conn ?? null,
        rawJson: rec.rawJson,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[mqtt-broker] insertGpsLocation failed: ${msg}`);
      return;
    }

    if ('skipped' in result) return;

    deps.broadcastLocation({
      id: result.id,
      user_id: rec.userId,
      device_id: rec.deviceId,
      recorded_at: new Date(rec.tst * 1000).toISOString(),
      lat: rec.lat,
      lon: rec.lon,
      accuracy_m: rec.accuracy ?? null,
      altitude_m: rec.altitude ?? null,
      velocity_kmh: rec.velocity ?? null,
      course_deg: rec.course ?? null,
    });
    deps.triggerResolveAsync(result.id, rec.lat, rec.lon);
    console.log(
      `[mqtt-broker] insert id=${result.id} ${rec.deviceId ?? '?'} ` +
      `(${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)})`,
    );
  });

  aedes.on('client', (client: AedesClient) => {
    console.log(`[mqtt-broker] client connected: ${client.id}`);
  });
  aedes.on('clientDisconnect', (client: AedesClient) => {
    console.log(`[mqtt-broker] client disconnected: ${client.id}`);
  });
  aedes.on('clientError', (client: AedesClient, err: Error) => {
    console.warn(`[mqtt-broker] client error (${client.id}): ${err.message}`);
  });

  const server: NetServer = netCreateServer(aedes.handle);
  server.listen(port, host, () => {
    const auth = expectedUsername ? `user='${expectedUsername}'` : 'no-auth';
    console.log(`[mqtt-broker] listening on mqtt://${host}:${port} (${auth}, topic=${topicMatch})`);
  });
  server.on('error', (err) => {
    console.error(`[mqtt-broker] tcp server error: ${err.message}`);
  });

  return {
    port,
    host,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          aedes.close(() => resolve());
        });
      }),
  };
}

/**
 * topicMatch (例 'owntracks/+/+') と incoming topic (例 'owntracks/me/iphone') を
 * MQTT wildcard ('+' = 1 segment, '#' = remainder) で比較する。
 */
function topicLooksLikeOwntracks(topic: string, pattern: string): boolean {
  const p = pattern.split('/');
  const t = topic.split('/');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true;
    if (i >= t.length) return false;
    if (p[i] === '+') continue;
    if (p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}
