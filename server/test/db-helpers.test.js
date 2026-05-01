import { describe, it, expect } from 'vitest';
import { safeParse, extractDomain, firstPathSegment } from '../db/_helpers.js';

describe('safeParse', () => {
  it('parses valid JSON', () => {
    expect(safeParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeParse('[1,2,3]')).toEqual([1, 2, 3]);
  });
  it('returns null for invalid JSON', () => {
    expect(safeParse('not json')).toBeNull();
    expect(safeParse('{')).toBeNull();
  });
});

describe('extractDomain', () => {
  it('returns lowercase host', () => {
    expect(extractDomain('https://EXAMPLE.com/path')).toBe('example.com');
  });
  it('null on parse error', () => {
    expect(extractDomain('garbage')).toBeNull();
  });
});

describe('firstPathSegment', () => {
  it('returns first path segment', () => {
    expect(firstPathSegment('https://example.com/foo/bar')).toBe('foo');
  });
  it('null when no path', () => {
    expect(firstPathSegment('https://example.com/')).toBeNull();
    expect(firstPathSegment('https://example.com')).toBeNull();
  });
  it('null on parse error', () => {
    expect(firstPathSegment('garbage')).toBeNull();
  });
});
