// 機微 API (personality export / agent 実行など) を、直接の loopback リクエストに限定する。

import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { hostname, networkInterfaces } from 'node:os';
import { isConfiguredBrowserHost } from '../browser-host-config.js';

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

function normalizeAddress(address: string): string {
  return address.toLowerCase().replace(/^::ffff:/, '').split('%', 1)[0];
}

function localMachineAddresses(): Set<string> {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(normalizeAddress(entry.address));
  }
  return addresses;
}

function isSameMachineAddress(address: string | undefined): boolean {
  if (!address) return false;
  return isLoopbackAddress(address)
    || localMachineAddresses().has(normalizeAddress(address));
}

function isSameMachineHostname(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const machine = hostname().toLowerCase().replace(/\.$/, '');
  const shortMachine = machine.split('.', 1)[0];
  return isLoopbackHostname(normalized)
    || normalized === machine
    || normalized === shortMachine
    || isConfiguredBrowserHost(normalized)
    || localMachineAddresses().has(normalizeAddress(normalized));
}

function hasSameOrigin(c: Context, requestUrl: URL, trustForwardedProtocol = false): boolean {
  const origin = c.req.header('Origin');
  if (!origin) return true;
  try {
    const forwardedProtocol = c.req.header('X-Forwarded-Proto')
      ?.split(',', 1)[0]
      ?.trim()
      .toLowerCase();
    const requestOrigin = trustForwardedProtocol
      && (forwardedProtocol === 'http' || forwardedProtocol === 'https')
      ? `${forwardedProtocol}://${requestUrl.host}`
      : requestUrl.origin;
    return new URL(origin).origin === requestOrigin;
  } catch {
    return false;
  }
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
  return hasSameOrigin(c, requestUrl);
}

/**
 * 同じ端末から、その端末自身の hostname / interface address で開いた UI を許可する。
 * 任意の LAN client や DNS rebinding host は許可しない。
 */
export function isSameMachineRequest(c: Context): boolean {
  let remoteAddress: string | undefined;
  try {
    remoteAddress = getConnInfo(c).remote.address;
  } catch {
    return false;
  }
  if (!isSameMachineAddress(remoteAddress)) return false;

  let requestUrl: URL;
  try {
    requestUrl = new URL(c.req.url);
  } catch {
    return false;
  }
  return isSameMachineHostname(requestUrl.hostname) && hasSameOrigin(c, requestUrl, true);
}
