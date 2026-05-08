/**
 * MQTT subscriber (mqtt.js)。 OwnTracks topic を購読し、 受信ごとに
 * onLocation コールバックを呼ぶ。 broker への切断は自動再接続で吸収。
 */

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { parseOwntracksLocation, parseOwntracksTopic, type OwntracksLocation, type OwntracksTopic } from './payload.js';
import type { OwntracksConfig } from './config.js';

export type LocationHandler = (
  topic: OwntracksTopic,
  loc: OwntracksLocation,
  ctx: { rawJson: string },
) => void | Promise<void>;

export function startOwntracksClient(config: OwntracksConfig, onLocation: LocationHandler): MqttClient {
  const opts: IClientOptions = {
    clientId: config.mqtt.clientId,
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
  };
  if (config.mqtt.username) opts.username = config.mqtt.username;
  if (config.mqtt.password) opts.password = config.mqtt.password;

  const client = mqtt.connect(config.mqtt.url, opts);

  client.on('connect', () => {
    console.log(`[owntracks] mqtt connected to ${config.mqtt.url}`);
    client.subscribe(config.mqtt.topic, { qos: 1 }, (err) => {
      if (err) {
        console.error(`[owntracks] subscribe failed: ${err.message}`);
      } else {
        console.log(`[owntracks] subscribed to ${config.mqtt.topic}`);
      }
    });
  });

  client.on('reconnect', () => console.log('[owntracks] mqtt reconnecting...'));
  client.on('close',     () => console.log('[owntracks] mqtt connection closed'));
  client.on('error',     (err: Error) => console.error(`[owntracks] mqtt error: ${err.message}`));

  client.on('message', async (topic, payload) => {
    const t = parseOwntracksTopic(topic);
    if (!t) return;
    let raw: unknown;
    let rawJson = '';
    try {
      rawJson = payload.toString('utf8');
      raw = JSON.parse(rawJson);
    } catch {
      return;
    }
    const loc = parseOwntracksLocation(raw);
    if (!loc) return;

    try {
      await onLocation(t, loc, { rawJson });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[owntracks] location handler threw: ${msg}`);
    }
  });

  return client;
}
