import type { ShoppingDigest, ShoppingSearchResult } from './types.js';

type CrawlInFlight =
  | { kind: 'refresh'; promise: Promise<ShoppingDigest> }
  | { kind: 'search'; query: string; promise: Promise<ShoppingSearchResult> };

export type ShoppingCrawlRequest<T> =
  | { status: 'started' | 'shared'; promise: Promise<T> }
  | { status: 'busy' };

/** Coordinates every shopping crawl in this process, regardless of its trigger. */
export class ShoppingCrawlCoordinator {
  private inFlight: CrawlInFlight | null = null;

  requestRefresh(run: () => Promise<ShoppingDigest>): ShoppingCrawlRequest<ShoppingDigest> {
    if (this.inFlight) return { status: 'busy' };
    const promise = Promise.resolve().then(run);
    const entry: CrawlInFlight = { kind: 'refresh', promise };
    this.inFlight = entry;
    this.clearWhenSettled(entry);
    return { status: 'started', promise };
  }

  requestSearch(
    query: string,
    run: () => Promise<ShoppingSearchResult>,
  ): ShoppingCrawlRequest<ShoppingSearchResult> {
    if (this.inFlight) {
      if (this.inFlight.kind === 'search' && this.inFlight.query === query) {
        return { status: 'shared', promise: this.inFlight.promise };
      }
      return { status: 'busy' };
    }
    const promise = Promise.resolve().then(run);
    const entry: CrawlInFlight = { kind: 'search', query, promise };
    this.inFlight = entry;
    this.clearWhenSettled(entry);
    return { status: 'started', promise };
  }

  private clearWhenSettled(entry: CrawlInFlight): void {
    const clear = (): void => {
      if (this.inFlight === entry) this.inFlight = null;
    };
    void entry.promise.then(clear, clear);
  }
}

export const shoppingCrawlCoordinator = new ShoppingCrawlCoordinator();
