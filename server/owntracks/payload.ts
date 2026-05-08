/**
 * OwnTracks payload / topic パーサ。
 *
 * topic: `owntracks/<user>/<device>`
 * payload (`_type='location'`):
 *   { lat, lon, tst, acc?, alt?, batt?, vel?, cog?, tid?, conn? }
 */

export interface OwntracksTopic {
  user: string;
  device: string;
}

export interface OwntracksLocation {
  _type: 'location';
  lat: number;
  lon: number;
  tst: number;            // Unix epoch (秒)
  acc?: number;           // 精度 (m)
  alt?: number;           // 標高 (m)
  batt?: number;          // バッテリー (%)
  vel?: number;           // 速度 (km/h)
  cog?: number;           // コンパス方位 (deg)
  tid?: string;           // track id ("iP" 等)
  conn?: string;          // "w" | "m" | "o"
}

export interface OwntracksDbRecord {
  userId: string;
  deviceId: string;
  tst: number;
  lat: number;
  lon: number;
  accuracy?: number;
  altitude?: number;
  velocity?: number;
  course?: number;
  battery?: number;
  conn?: string;
  rawJson: string | null;
}

/**
 * `owntracks/<user>/<device>` を分解。 prefix 違反 / parts 不足は null。
 */
export function parseOwntracksTopic(topic: string): OwntracksTopic | null {
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
 * 不正なら null。 lat / lon / tst のみ必須、 それ以外は省略可。
 */
export function parseOwntracksLocation(input: unknown): OwntracksLocation | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
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
 */
export function locationToDbRecord(
  topic: OwntracksTopic,
  loc: OwntracksLocation,
  ctx: { userId: string; rawJson?: string },
): OwntracksDbRecord {
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
