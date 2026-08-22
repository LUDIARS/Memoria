import type { ReleaseDigest } from './types.js';

export type ReleaseCrawlRequest =
  | { status: 'started'; promise: Promise<ReleaseDigest> }
  | { status: 'busy' };

/** 手動更新とスケジューラの巡回が同時に走らないよう、 プロセス内で 1 本に絞る。 */
export class ReleaseCrawlCoordinator {
  private inFlight: Promise<ReleaseDigest> | null = null;

  request(run: () => Promise<ReleaseDigest>): ReleaseCrawlRequest {
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

export const releaseCrawlCoordinator = new ReleaseCrawlCoordinator();
