import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function inV4Range(ipInt: number, cidrBase: string, prefix: number): boolean {
  const base = ipv4ToInt(cidrBase);
  if (base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (base & mask);
}

function isBlockedV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true;
  const blocked: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  return blocked.some(([base, prefix]) => inV4Range(value, base, prefix));
}

function parseV6Words(ip: string): number[] | null {
  let normalized = ip.toLowerCase().split('%', 1)[0];
  const dottedTail = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (dottedTail) {
    const value = ipv4ToInt(dottedTail);
    if (value === null) return null;
    normalized = `${normalized.slice(0, -dottedTail.length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

function embeddedV4(words: number[]): string | null {
  const hasZeroPrefix = (length: number): boolean => words.slice(0, length).every((word) => word === 0);
  const isCompatible = hasZeroPrefix(6);
  const isMapped = hasZeroPrefix(5) && words[5] === 0xffff;
  const isTranslated = hasZeroPrefix(4) && words[4] === 0xffff && words[5] === 0;
  const isWellKnownNat64 = words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0);
  if (!isCompatible && !isMapped && !isTranslated && !isWellKnownNat64) return null;
  return `${words[6] >>> 8}.${words[6] & 0xff}.${words[7] >>> 8}.${words[7] & 0xff}`;
}

function isBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%', 1)[0];
  if (lower === '::1' || lower === '::') return true;
  const words = parseV6Words(lower);
  if (!words) return true;
  const v4 = embeddedV4(words);
  if (v4 !== null) return isBlockedV4(v4);
  // 6to4 embeds the destination IPv4 address immediately after 2002::/16.
  if (words[0] === 0x2002) {
    const tunneledV4 = `${words[1] >>> 8}.${words[1] & 0xff}.${words[2] >>> 8}.${words[2] & 0xff}`;
    if (isBlockedV4(tunneledV4)) return true;
  }
  const head = lower.split(':')[0] ?? '';
  const value = parseInt(head || '0', 16);
  if (Number.isNaN(value)) return true;
  if ((value & 0xfe00) === 0xfc00) return true;
  if ((value & 0xffc0) === 0xfe80) return true;
  if ((value & 0xff00) === 0xff00) return true;
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true;
}

/**
 * Rejects non-HTTP schemes and hostnames that currently resolve to non-public addresses.
 * Callers must repeat this check for every redirect. The later network connection performs
 * its own DNS lookup, so DNS rebinding between validation and connection remains a residual risk.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(`invalid url: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`scheme not allowed: ${url.protocol}`);
  }
  if (!url.hostname) throw new BlockedUrlError('empty host');

  const literal = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (isIP(literal)) {
    if (isBlockedAddress(literal)) throw new BlockedUrlError(`blocked address: ${literal}`);
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new BlockedUrlError(`dns lookup failed: ${url.hostname}`);
  }
  if (addresses.length === 0) throw new BlockedUrlError(`no address: ${url.hostname}`);
  for (const address of addresses) {
    if (isBlockedAddress(address.address)) {
      throw new BlockedUrlError(`${url.hostname} resolves to blocked address ${address.address}`);
    }
  }
}
