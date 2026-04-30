/**
 * OwnTracks payload / topic パーサ。Iv (Imperativus) の TypeScript 実装を
 * Memoria 用に plain JS で port した。
 *
 * topic: `owntracks/<user>/<device>`
 * payload (`_type='location'`):
 *   { lat, lon, tst, acc?, alt?, batt?, vel?, cog?, tid?, conn? }
 */

/**
 * `owntracks/<user>/<device>` を分解。 prefix 違反 / parts 不足は null。
 *
 * @param {string} topic
 * @returns {{ user: string, device: string } | null}
 */
export function parseOwntracksTopic(topic) {
  if (typeof topic !== 'string') return null;
  const parts = topic.split('/');
  if (parts.length < 3) return null;
  if (parts[0] !== 'owntracks') return null;
  const user = parts[1];
  const device = parts[2];
  if (!user || !device) return null;
  return { user, device };
}

/**
 * OwnTracks `_type='location'` payload を narrow + 必須 field を検証。
 * 不正なら null。lat / lon / tst のみ必須、それ以外は省略可。
 *
 * @param {unknown} input
 * @returns {OwntracksLocation | null}
 */
export function parseOwntracksLocation(input) {
  if (typeof input !== 'object' || input === null) return null;
  const o = /** @type {Record<string, unknown>} */ (input);
  if (o._type !== 'location') return null;
  if (typeof o.lat !== 'number' || !Number.isFinite(o.lat)) return null;
  if (typeof o.lon !== 'number' || !Number.isFinite(o.lon)) return null;
  if (typeof o.tst !== 'number' || !Number.isFinite(o.tst)) return null;
  if (o.lat < -90 || o.lat > 90) return null;
  if (o.lon < -180 || o.lon > 180) return null;

  return {
    _type: 'location',
    lat: o.lat,
    lon: o.lon,
    tst: o.tst,
    acc: typeof o.acc === 'number' ? o.acc : undefined,
    alt: typeof o.alt === 'number' ? o.alt : undefined,
    batt: typeof o.batt === 'number' ? o.batt : undefined,
    vel: typeof o.vel === 'number' ? o.vel : undefined,
    cog: typeof o.cog === 'number' ? o.cog : undefined,
    tid: typeof o.tid === 'string' ? o.tid : undefined,
    conn: typeof o.conn === 'string' ? o.conn : undefined,
  };
}

/**
 * OwnTracks Location → DB insert 用 record にマップする。
 * 呼び出し側は user_id を userMapping (env) から resolve した上で渡す。
 *
 * @param {{ user: string, device: string }} topic
 * @param {OwntracksLocation} loc
 * @param {{ userId: string, rawJson?: string }} ctx
 */
export function locationToDbRecord(topic, loc, ctx) {
  return {
    userId: ctx.userId,
    deviceId: topic.device,
    tst: loc.tst,
    lat: loc.lat,
    lon: loc.lon,
    accuracy: loc.acc,
    altitude: loc.alt,
    velocity: loc.vel,
    course: loc.cog,
    battery: loc.batt,
    conn: loc.conn,
    rawJson: ctx.rawJson ?? null,
  };
}

/**
 * @typedef {Object} OwntracksLocation
 * @property {'location'} _type
 * @property {number} lat
 * @property {number} lon
 * @property {number} tst                Unix epoch (秒)
 * @property {number=} acc               精度 (m)
 * @property {number=} alt               標高 (m)
 * @property {number=} batt              バッテリー (%)
 * @property {number=} vel               速度 (km/h)
 * @property {number=} cog               コンパス方位 (deg)
 * @property {string=} tid               track id ("iP" 等)
 * @property {string=} conn              "w"|"m"|"o"
 */
