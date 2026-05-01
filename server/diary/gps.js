// GPS / location summarization helpers.

// SQLite stores datetime() values as UTC strings without a timezone marker
// ("2026-04-27 02:00:00"). new Date() on that string parses it as local
// time — wrong by the local TZ offset. Append `Z` so JS parses it as UTC,
// then standard accessors (getHours(), toLocaleString(), etc.) return the
// correct LOCAL values.
export function parseSqliteUtc(s) {
  if (!s) return null;
  const iso = String(s).replace(' ', 'T');
  // Already has TZ info — leave it alone.
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) return new Date(iso);
  return new Date(iso + 'Z');
}

// Haversine 距離 (m)。地球半径 6371008 m (mean)。短距離では誤差は数 cm 以下。
export function haversineMeters(a, b) {
  const R = 6_371_008;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sa = Math.sin(dLat / 2);
  const so = Math.sin(dLon / 2);
  const h = sa * sa + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * so * so;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 当日の GPS 点列から日記用 metrics を組み立てる。
 *
 * 出力:
 *   { points, devices, distance_meters, bbox, midpoint, hours, first_at, last_at }
 *
 * `bbox` / `midpoint` は Opus 1M プロンプトで「どのあたりに居たか」を
 * narrate させるのに最低限必要な情報。`midpoint` は `bbox` の中心。
 *
 * 静止判定 (e.g., 同一地点で 30 分滞留 = 「滞在」) は誤判定リスクが高いので
 * 当面は実装しない。アクティブ時間帯 (`hours`) のみ使う。
 *
 * 距離は連続する 2 点間 haversine の和。jitter 込みなので「歩いた距離」より
 * やや大きめになるが、概算用途なら十分。
 */
export function summarizeGpsForDate(points) {
  if (!points || points.length === 0) {
    return {
      points: 0,
      devices: [],
      distance_meters: 0,
      bbox: null,
      midpoint: null,
      hours: [],
      first_at: null,
      last_at: null,
    };
  }
  const devices = new Set();
  const hourSet = new Set();
  let minLat = +Infinity, maxLat = -Infinity;
  let minLon = +Infinity, maxLon = -Infinity;
  let dist = 0;
  let prev = null;
  for (const p of points) {
    if (p.device_id) devices.add(p.device_id);
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    const h = parseSqliteUtc(p.recorded_at)?.getHours();
    if (Number.isFinite(h)) hourSet.add(h);
    if (prev) {
      // Skip outliers: accuracy なし or > 200m の点は連続性を信頼しない
      const accOk = !p.accuracy_m || p.accuracy_m < 200;
      if (accOk) dist += haversineMeters(prev, p);
    }
    prev = p;
  }
  return {
    points: points.length,
    devices: [...devices],
    distance_meters: Math.round(dist),
    bbox: {
      lat: [Number(minLat.toFixed(5)), Number(maxLat.toFixed(5))],
      lon: [Number(minLon.toFixed(5)), Number(maxLon.toFixed(5))],
    },
    midpoint: {
      lat: Number(((minLat + maxLat) / 2).toFixed(5)),
      lon: Number(((minLon + maxLon) / 2).toFixed(5)),
    },
    hours: [...hourSet].sort((a, b) => a - b),
    first_at: points[0].recorded_at ?? null,
    last_at: points[points.length - 1].recorded_at ?? null,
  };
}
