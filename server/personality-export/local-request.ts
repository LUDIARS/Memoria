// Personality export の opt-in と credential 操作を、直接の loopback リクエストに限定する。

import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
    || /^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function isDirectLoopbackRequest(c: Context): boolean {
  let remoteAddress: string | undefined;
  try {
    remoteAddress = getConnInfo(c).remote.address;
  } catch {
    // Node adapter の接続情報が無い実行環境は、安全側に倒して拒否する。
    return false;
  }
  if (!isLoopbackAddress(remoteAddress)) return false;

  let requestUrl: URL;
  try {
    requestUrl = new URL(c.req.url);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(requestUrl.hostname)) return false;

  // 外部ページから localhost API を呼ぶ browser-based CSRF は Origin 不一致で拒否する。
  const origin = c.req.header('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === requestUrl.origin;
  } catch {
    return false;
  }
}
