import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { BlockedUrlError, isBlockedAddress } from './public-url.js';
import { contract } from '../shared/contract-runtime.js'; /* augur-inject:import:915ba872 */
import augurContract_d85fa331 from '../../augur/contracts/security-address.contract.js'; /* augur-inject:contract-predicate:8247c8d5 */

type Address = { address: string; family: number };
export type PublicLookup = (hostname: string) => Promise<Address[]>;
const systemLookup: PublicLookup = (hostname) => lookup(hostname, { all: true });

export async function resolvePublicAddress(url: URL, resolve: PublicLookup = systemLookup): Promise<Address> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new BlockedUrlError('only credential-free HTTP(S) URLs are allowed');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await resolve(host);
  if (!addresses.length || addresses.some((item) => isBlockedAddress(item.address)
    || isIP(item.address) !== item.family)) {
    throw new BlockedUrlError('URL resolves to a non-public address');
  }
  return addresses[0];
}
// @ts-expect-error augur-inject
resolvePublicAddress = contract(resolvePublicAddress, { ...augurContract_d85fa331, contractId: 'C-8', mode: 'observe', sample: 1, where: 'server/shared/public-connection.ts:12', rule: 'contract-wrap', id: 'd85fa331' }); /* augur-inject:contract-wrap:d85fa331 */

/** DNS is evaluated once per hop. The HTTP client receives only the checked IP. */
export async function fetchPinnedPublicResponse(
  rawUrl: string,
  options: { signal: AbortSignal; headers: Record<string, string> },
  dependencies: { resolve?: PublicLookup; request?: typeof httpRequest } = {},
): Promise<Response> {
  const url = new URL(rawUrl);
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error('public fetch aborted'));
    if (options.signal.aborted) { abort(); return; }
    options.signal.addEventListener('abort', abort, { once: true });
    void resolvePublicAddress(url, dependencies.resolve).then((address) => {
      options.signal.removeEventListener('abort', abort);
      if (options.signal.aborted) { abort(); return; }
      const headers = Object.fromEntries(Object.entries(options.headers)
        .filter(([key]) => !['host', 'connection', 'accept-encoding'].includes(key.toLowerCase())));
      const request = (dependencies.request ?? (url.protocol === 'https:' ? httpsRequest : httpRequest))(url, {
        method: 'GET', agent: false, signal: options.signal,
        headers: { ...headers, 'Accept-Encoding': 'identity' },
        // Keep the original URL/Host/SNI for TLS verification; never resolve it again.
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        family: address.family,
      }, (incoming) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') {
          incoming.destroy();
          reject(new Error('compressed response to identity request is not supported'));
          return;
        }
        const status = incoming.statusCode ?? 502;
        const noBody = [204, 205, 304].includes(status);
        if (noBody) incoming.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
          status, headers: responseHeaders,
        }));
      });
      request.on('error', reject);
      request.end();
    }, (error: unknown) => {
      options.signal.removeEventListener('abort', abort);
      reject(error);
    }).catch(reject);
  });
}
