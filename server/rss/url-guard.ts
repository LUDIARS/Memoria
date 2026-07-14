// SSRF guard — フィード取得 URL が内部/予約レンジを指していないか検証する。
//
// RSS 登録・discover・poll はユーザ任意の URL を fetch するため、
// localhost / private range / link-local (169.254.169.254 等のメタデータ) への
// アクセスを許すと SSRF になる。ここでスキーム + 名前解決後の IP を検査する。
//
// 注意 (残存リスク): DNS rebinding (検査後に名前解決が変わる TOCTOU) は
// fetch が解決済み IP に固定接続しないため完全には塞げない。実害を下げるため
// 全解決 IP を検査し、リダイレクトは hop ごとに再検査する (sources.ts 側)。

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

/** IPv4 文字列を 32bit 整数へ。失敗時 null。 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = v * 256 + n;
  }
  return v >>> 0;
}

function inV4Range(ipInt: number, cidrBase: string, prefix: number): boolean {
  const base = ipv4ToInt(cidrBase);
  if (base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (base & mask);
}

/** internal/予約 IPv4 か。SSRF で危険なレンジを遮断する。 */
function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // パース不能は安全側で遮断
  const blocked: Array<[string, number]> = [
    ['0.0.0.0', 8],        // "this" network
    ['10.0.0.0', 8],       // private
    ['100.64.0.0', 10],    // CGNAT
    ['127.0.0.0', 8],      // loopback
    ['169.254.0.0', 16],   // link-local (cloud metadata 169.254.169.254 含む)
    ['172.16.0.0', 12],    // private
    ['192.0.0.0', 24],     // IETF protocol assignments
    ['192.168.0.0', 16],   // private
    ['198.18.0.0', 15],    // benchmarking
    ['224.0.0.0', 4],      // multicast
    ['240.0.0.0', 4],      // reserved / 255.255.255.255 含む
  ];
  return blocked.some(([base, prefix]) => inV4Range(n, base, prefix));
}

/** internal/予約 IPv6 か。IPv4-mapped は埋め込み v4 で判定。 */
function isBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) は v4 として判定
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedV4(mapped[1]);
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  const head = lower.split(':')[0] ?? '';
  const h = parseInt(head || '0', 16);
  if (Number.isNaN(h)) return true;
  if ((h & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((h & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * 解決済み IP (リテラル) が internal/予約レンジなら true。
 * テスト容易性のため純粋関数として公開する。
 */
export function isBlockedAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedV4(ip);
  if (fam === 6) return isBlockedV6(ip);
  return true; // IP でない文字列は安全側で遮断
}

/**
 * フィード取得を許可してよい URL か検証する。NG なら BlockedUrlError を投げる。
 * - スキームは http / https のみ
 * - ホスト名を名前解決し、全解決 IP が public であること
 */
export async function assertFetchableFeedUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(`invalid url: ${rawUrl}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new BlockedUrlError(`scheme not allowed: ${u.protocol}`);
  }
  const host = u.hostname;
  if (!host) throw new BlockedUrlError('empty host');

  // ホストが IP リテラルなら直接判定 (DNS 不要)。URL は IPv6 を [..] で囲む。
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(literal)) {
    if (isBlockedAddress(literal)) throw new BlockedUrlError(`blocked address: ${literal}`);
    return;
  }

  // ホスト名は全 A/AAAA を解決して検査 (どれか1つでも internal なら遮断)。
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError(`dns lookup failed: ${host}`);
  }
  if (addrs.length === 0) throw new BlockedUrlError(`no address: ${host}`);
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) {
      throw new BlockedUrlError(`host ${host} resolves to blocked address ${a.address}`);
    }
  }
}
