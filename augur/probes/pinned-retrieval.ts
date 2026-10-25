import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { request, RequestOptions, IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import type { PublicLookup } from '../../server/shared/public-connection.js';
import { fetchFeedXml } from '../../server/rss/sources.js';
import { crawlShoppingSource } from '../../server/shopping/crawler.js';
import { contract } from '../shared/contract-runtime.js'; /* augur-inject:import:ea693fd5 */
import augurContract_49019dc7 from '../contracts/pinned-retrieval.contract.js'; /* augur-inject:contract-predicate:015496f7 */
import augurContract_f7228d4d from '../contracts/pinned-retrieval.contract.js'; /* augur-inject:contract-predicate:2008d406 */

// Real production retrieval with in-memory DNS/HTTP; a second DNS resolution of
// either hostname returns loopback, so a reconnect cannot silently pass.
interface PinnedEvidence {
  resolutions: string[];
  connections: Array<{ host: string; address: string; family: number; identity: boolean }>;
  bodyMatches: boolean;
}

function createTransport(body: string, contentType: string): {
  dependencies: { resolve: PublicLookup; request: typeof request };
  resolutions: PinnedEvidence['resolutions'];
  connections: PinnedEvidence['connections'];
} {
  const resolutions: string[] = [];
  const connections: Array<{ host: string; address: string; family: number; identity: boolean }> = [];
  const resolve = async (host: string) => {
    const repeated = resolutions.includes(host);
    resolutions.push(host);
    return [{ address: repeated ? '127.0.0.1' : host === 'first.test' ? '8.8.8.8' : '1.1.1.1', family: 4 }];
  };
  const fakeRequest = ((url: URL, options: RequestOptions, onResponse: (res: IncomingMessage) => void) => {
    const lookup = options.lookup as LookupFunction;
    // Exercise the connection lookup twice; neither call may consult DNS again.
    for (let attempt = 0; attempt < 2; attempt++) {
      lookup(url.hostname, {}, (error, address, family) => {
        if (error) throw error;
        if (attempt === 0) connections.push({
          host: url.hostname, address: address as string, family: family as number,
          identity: (options.headers as Record<string, string>)['Accept-Encoding'] === 'identity',
        });
        else if (address !== connections.at(-1)?.address) throw new Error('connection address changed');
      });
    }
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      const redirect = url.hostname === 'first.test';
      const stream = Object.assign(new PassThrough(), {
        statusCode: redirect ? 302 : 200,
        headers: redirect ? { location: 'https://second.test/final' } : { 'content-type': contentType },
      });
      onResponse(stream as unknown as IncomingMessage);
      stream.end(redirect ? '' : body);
    };
    return req;
  }) as unknown as typeof request;
  return { dependencies: { resolve, request: fakeRequest }, resolutions, connections };
}

export async function feedPinnedEvidence(): Promise<PinnedEvidence> {
  const xml = '<rss><channel><title>public feed</title></channel></rss>';
  const transport = createTransport(xml, 'application/rss+xml');
  const body = await fetchFeedXml('https://first.test/feed', 20_000, transport.dependencies);
  return { resolutions: transport.resolutions, connections: transport.connections, bodyMatches: body === xml };
}
// @ts-expect-error augur-inject
feedPinnedEvidence = contract(feedPinnedEvidence, { ...augurContract_49019dc7, contractId: 'C-21', mode: 'observe', sample: 1, where: 'augur/probes/pinned-retrieval.ts:46', rule: 'contract-wrap', id: '49019dc7' }); /* augur-inject:contract-wrap:49019dc7 */

export async function shoppingPinnedEvidence(): Promise<PinnedEvidence> {
  const html = '<script type="application/ld+json">{"@type":"Product","name":"rice","url":"/rice","offers":{"price":"100"}}</script>';
  const transport = createTransport(html, 'text/html');
  const offers = await crawlShoppingSource({
    id: 'test', name: 'test', kind: 'online', pageUrl: 'https://first.test/shop',
    searchUrlTemplate: null, shippingMode: 'free', flatShippingYen: null, enabled: true,
  }, undefined, transport.dependencies);
  return {
    resolutions: transport.resolutions, connections: transport.connections,
    bodyMatches: offers.length === 1 && offers[0].title === 'rice'
      && offers[0].priceYen === 100 && offers[0].url === 'https://second.test/rice',
  };
}
// @ts-expect-error augur-inject
shoppingPinnedEvidence = contract(shoppingPinnedEvidence, { ...augurContract_f7228d4d, contractId: 'C-22', mode: 'observe', sample: 1, where: 'augur/probes/pinned-retrieval.ts:53', rule: 'contract-wrap', id: 'f7228d4d' }); /* augur-inject:contract-wrap:f7228d4d */
