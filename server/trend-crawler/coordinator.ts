import type { TrendCrawlResult } from './types.js';

export type TrendCrawlRequest =
  | { status: 'started'; promise: Promise<TrendCrawlResult> }
  | { status: 'busy' };

/** 手動更新とスケジューラの巡回が同時に走らないよう、 プロセス内で 1 本に絞る。 */
export class TrendCrawlCoordinator {
  private inFlight: Promise<TrendCrawlResult> | null = null;

  request(run: () => Promise<TrendCrawlResult>): TrendCrawlRequest {
    if (this.inFlight) return { status: 'busy' };
    const promise = Promise.resolve().then(run);
    this.inFlight = promise;
    const clear = (): void => { if (this.inFlight === promise) this.inFlight = null; };
    void promise.then(clear, clear);
    return { status: 'started', promise };
  }

  get busy(): boolean {
    return this.inFlight !== null;
  }
}

export const trendCrawlCoordinator = new TrendCrawlCoordinator();
