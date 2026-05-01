import { describe, it, expect } from 'vitest';
import {
  extractDomain,
  formatLocalDate,
  yesterdayLocal,
  weekRangeFor,
  weekOfMonth,
} from '../diary/date.js';

describe('extractDomain', () => {
  it('returns lowercase host for valid URL', () => {
    expect(extractDomain('https://Example.com/foo')).toBe('example.com');
  });
  it('returns null for garbage', () => {
    expect(extractDomain('not a url')).toBeNull();
    expect(extractDomain(null)).toBeNull();
    expect(extractDomain('')).toBeNull();
  });
});

describe('formatLocalDate', () => {
  it('formats as YYYY-MM-DD', () => {
    const d = new Date(2026, 0, 5); // Jan 5, 2026
    expect(formatLocalDate(d)).toBe('2026-01-05');
  });
});

describe('yesterdayLocal', () => {
  it('subtracts one day', () => {
    const now = new Date(2026, 4, 1, 9, 0); // May 1
    expect(yesterdayLocal(now)).toBe('2026-04-30');
  });
  it('handles month rollover', () => {
    const now = new Date(2026, 0, 1); // Jan 1
    expect(yesterdayLocal(now)).toBe('2025-12-31');
  });
});

describe('weekRangeFor', () => {
  it('Monday returns Mon-Sun span', () => {
    // 2026-04-27 is a Monday
    expect(weekRangeFor('2026-04-27')).toEqual({ start: '2026-04-27', end: '2026-05-03' });
  });
  it('Sunday returns previous Monday span', () => {
    // 2026-05-03 is a Sunday
    expect(weekRangeFor('2026-05-03')).toEqual({ start: '2026-04-27', end: '2026-05-03' });
  });
  it('Wednesday returns containing Mon-Sun', () => {
    // 2026-04-29 is a Wednesday
    expect(weekRangeFor('2026-04-29')).toEqual({ start: '2026-04-27', end: '2026-05-03' });
  });
});

describe('weekOfMonth', () => {
  it('first Monday is week 1', () => {
    // 2026-05-04 is the first Monday of May 2026
    expect(weekOfMonth('2026-05-04')).toEqual({ month: '2026-05', weekInMonth: 1 });
  });
  it('second Monday is week 2', () => {
    expect(weekOfMonth('2026-05-11')).toEqual({ month: '2026-05', weekInMonth: 2 });
  });
});
