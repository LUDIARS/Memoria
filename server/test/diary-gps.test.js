import { describe, it, expect } from 'vitest';
import { haversineMeters, parseSqliteUtc, summarizeGpsForDate } from '../diary/gps.js';

describe('haversineMeters', () => {
  it('returns 0 for identical points', () => {
    const p = { lat: 35.6762, lon: 139.6503 };
    expect(haversineMeters(p, p)).toBe(0);
  });
  it('Tokyo→Osaka ≒ 397 km', () => {
    const tokyo = { lat: 35.6762, lon: 139.6503 };
    const osaka = { lat: 34.6937, lon: 135.5023 };
    const m = haversineMeters(tokyo, osaka);
    // great-circle distance ~392 km, allow ±5 km tolerance
    expect(m).toBeGreaterThan(388_000);
    expect(m).toBeLessThan(397_000);
  });
  it('1° latitude ≒ 111 km', () => {
    const a = { lat: 0, lon: 0 };
    const b = { lat: 1, lon: 0 };
    const m = haversineMeters(a, b);
    expect(m).toBeGreaterThan(110_000);
    expect(m).toBeLessThan(112_000);
  });
});

describe('parseSqliteUtc', () => {
  it('null/empty returns null', () => {
    expect(parseSqliteUtc(null)).toBeNull();
    expect(parseSqliteUtc('')).toBeNull();
  });
  it('SQLite datetime() format is parsed as UTC', () => {
    // SQLite "2026-05-01 03:00:00" → UTC 03:00. In JST (+09:00) this should be 12:00 local.
    const d = parseSqliteUtc('2026-05-01 03:00:00');
    expect(d.toISOString()).toBe('2026-05-01T03:00:00.000Z');
  });
  it('explicit Z suffix is honored', () => {
    const d = parseSqliteUtc('2026-05-01T03:00:00Z');
    expect(d.toISOString()).toBe('2026-05-01T03:00:00.000Z');
  });
});

describe('summarizeGpsForDate', () => {
  it('empty input returns zero metrics', () => {
    const r = summarizeGpsForDate([]);
    expect(r.points).toBe(0);
    expect(r.distance_meters).toBe(0);
    expect(r.bbox).toBeNull();
    expect(r.midpoint).toBeNull();
  });
  it('aggregates simple sequence', () => {
    const pts = [
      { recorded_at: '2026-05-01 00:00:00', lat: 35.0, lon: 135.0, device_id: 'd1' },
      { recorded_at: '2026-05-01 00:30:00', lat: 35.01, lon: 135.0, device_id: 'd1' },
    ];
    const r = summarizeGpsForDate(pts);
    expect(r.points).toBe(2);
    expect(r.distance_meters).toBeGreaterThan(1000); // ~1.1 km
    expect(r.distance_meters).toBeLessThan(1200);
    expect(r.bbox).toEqual({ lat: [35.0, 35.01], lon: [135.0, 135.0] });
    expect(r.midpoint).toEqual({ lat: 35.005, lon: 135.0 });
    expect(r.devices).toEqual(['d1']);
  });
});
