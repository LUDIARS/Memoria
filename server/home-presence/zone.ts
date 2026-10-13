// 自宅との距離と zone 判定 (純関数)。 境界の行き来で揺れないようヒステリシスを持つ。

import type { Zone } from './types.js';

export function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface ZoneRadii {
  homeM: number;
  nearM: number;
  hysteresisM: number;
}

/**
 * 距離から zone を決める。 前回の zone から出るときだけヒステリシス分の余裕を足す。
 * - home から出るのは homeM + H を超えたとき。
 * - near から away へ出るのは nearM + H を超えたとき。
 */
export function classifyZone(distanceM: number, prev: Zone | null, r: ZoneRadii): Zone {
  const nearM = Math.max(r.nearM, r.homeM);
  if (prev === 'home') {
    if (distanceM <= r.homeM + r.hysteresisM) return 'home';
    return distanceM <= nearM + r.hysteresisM ? 'near' : 'away';
  }
  if (distanceM <= r.homeM) return 'home';
  if (prev === 'near') return distanceM <= nearM + r.hysteresisM ? 'near' : 'away';
  return distanceM <= nearM ? 'near' : 'away';
}
