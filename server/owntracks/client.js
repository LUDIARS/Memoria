/**
 * MQTT subscriber (mqtt.js)。 OwnTracks topic を購読し、 受信ごとに
 * onLocation コールバックを呼ぶ。 broker への切断は自動再接続で吸収。
 *
 * Iv (Imperativus) の TypeScript 実装を Memoria 用 plain JS に port。
 */

import mqtt from 'mqtt';
import { parseOwntracksLocation, parseOwntracksTopic } from './payload.js';

/**
 * @callback LocationHandler
 * @param {{ user: string, device: string }} topic
 * @param {import('./payload.js').OwntracksLocation} loc
 * @param {{ rawJson: string }} ctx  受信生データ (DB 保存用)
 * @returns {void | Promise<void>}
 */

/**
 * MQTT に接続して OwnTracks topic を subscribe、 受信ごとに onLocation を呼ぶ。
 *
 * @param {import('./config.js').OwntracksConfig} config
 * @param {LocationHandler} onLocation
 * @returns {import('mqtt').MqttClient}
 */
export function startOwntracksClient(config, onLocation) {
  /** @type {import('mqtt').IClientOptions} */
  const opts = {
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
  client.on('error',     (err) => console.error(`[owntracks] mqtt error: ${err.message}`));

  client.on('message', async (topic, payload) => {
    const t = parseOwntracksTopic(topic);
    if (!t) return;
    let raw;
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
    } catch (err) {
      console.error(`[owntracks] location handler threw: ${err?.message ?? err}`);
    }
  });

  return client;
}
