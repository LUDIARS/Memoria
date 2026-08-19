import type BetterSqlite3 from 'better-sqlite3';
import { crawlShoppingSource } from './crawler.js';
import { getShoppingConfig, setShoppingDigest } from './config.js';
import type {
  ShoppingDigest,
  ShoppingOffer,
  ShoppingSearchResult,
  ShoppingSource,
  ShoppingSourceFailure,
} from './types.js';

type Db = BetterSqlite3.Database;

const MAX_CONCURRENT_SOURCE_CRAWLS = 4;

type CrawlSource = (source: ShoppingSource, query?: string) => Promise<ShoppingOffer[]>;

interface CrawlSourcesOptions {
  query?: string;
  crawlSource?: CrawlSource;
}

function localDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function safeFailureMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.replace(/https?:\/\/[^\s]+/g, '[source URL]').slice(0, 240);
}

async function mapSettledWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function crawlShoppingSources(
  sources: ShoppingSource[],
  maxItemsPerSource: number,
  options: CrawlSourcesOptions = {},
): Promise<{ offers: ShoppingOffer[]; failures: ShoppingSourceFailure[] }> {
  const query = options.query;
  const crawlSource = options.crawlSource ?? crawlShoppingSource;
  const settled = await mapSettledWithConcurrency(sources, MAX_CONCURRENT_SOURCE_CRAWLS, async (source) => (
    (await crawlSource(source, query))
      .sort(query ? compareOffers : () => 0)
      .slice(0, maxItemsPerSource)
  ));
  const offers: ShoppingOffer[] = [];
  const failures: ShoppingSourceFailure[] = [];
  settled.forEach((result, index) => {
    const source = sources[index];
    if (result.status === 'fulfilled') {
      if (!query && result.value.length === 0) {
        failures.push({ sourceId: source.id, sourceName: source.name, message: '商品を抽出できませんでした' });
        return;
      }
      offers.push(...result.value);
      return;
    }
    failures.push({ sourceId: source.id, sourceName: source.name, message: safeFailureMessage(result.reason) });
  });
  return { offers, failures };
}

function compareOffers(left: ShoppingOffer, right: ShoppingOffer): number {
  if (left.totalYen === null && right.totalYen === null) return left.priceYen - right.priceYen;
  if (left.totalYen === null) return 1;
  if (right.totalYen === null) return -1;
  return left.totalYen - right.totalYen;
}

export function findShippingInclusiveWinner(offers: ShoppingOffer[]): ShoppingOffer | null {
  return offers
    .filter((offer) => offer.totalYen !== null)
    .sort(compareOffers)[0] ?? null;
}

export async function searchShopping(db: Db, query: string): Promise<ShoppingSearchResult> {
  const config = getShoppingConfig(db);
  const sources = config.sources.filter((source) => source.enabled);
  const crawled = await crawlShoppingSources(sources, config.maxItemsPerSource, { query });
  const offers = crawled.offers.sort(compareOffers);
  return {
    query,
    searchedAt: new Date().toISOString(),
    winner: findShippingInclusiveWinner(offers),
    offers,
    failures: crawled.failures,
  };
}

export async function refreshShoppingDigest(db: Db, now = new Date()): Promise<ShoppingDigest> {
  const config = getShoppingConfig(db);
  const sources = config.sources.filter((source) => source.enabled);
  const crawled = await crawlShoppingSources(sources, config.maxItemsPerSource);
  const items = crawled.offers
    .sort((left, right) => left.sourceName.localeCompare(right.sourceName, 'ja') || compareOffers(left, right));
  if (items.length === 0 && crawled.failures.length > 0) {
    throw new Error(`all shopping sources failed (${crawled.failures.length})`);
  }
  const digest: ShoppingDigest = {
    date: localDate(now),
    generatedAt: now.toISOString(),
    items,
    failures: crawled.failures,
  };
  setShoppingDigest(db, digest);
  return digest;
}
