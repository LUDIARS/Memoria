import { fetchKantoPage } from './fetcher.js';
import { REFRESH_MS, SOURCE_URL, type RailData, type RailSnapshot } from './types.js';

/** Owns the shared snapshot and its refresh lifecycle; requests never trigger extra Yahoo fetches. */
export class RailStatusCache {
  private snapshot: RailSnapshot = { version: 1, source: 'yahoo-kanto', sourceUrl: SOURCE_URL,
    status: 'pending', fetchedAt: null, sourceUpdatedAt: null, stale: true, error: null, lines: [] };
  private timer?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  constructor(private readonly load: (signal: AbortSignal) => Promise<RailData> = fetchKantoPage,
    private readonly now: () => number = Date.now) {}

  state(): RailSnapshot {
    const at = this.snapshot.fetchedAt;
    return { ...this.snapshot, stale: this.snapshot.status !== 'ok' || at === null
      || this.now() - Date.parse(at) >= REFRESH_MS * 2 };
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.refresh(); }, REFRESH_MS);
    this.timer.unref();
    void this.refresh();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }
  async refresh(): Promise<void> {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const data = await this.load(controller.signal);
      if (controller.signal.aborted) return;
      if (data.lines.length < this.snapshot.lines.length * 0.9) throw new Error('unexpected_line_loss');
      this.snapshot = { ...this.snapshot, ...data, status: 'ok', fetchedAt: new Date(this.now()).toISOString(), stale: false, error: null };
    } catch {
      if (!controller.signal.aborted) this.snapshot = { ...this.snapshot, status: 'error', stale: true, error: 'source_fetch_failed' };
    } finally { this.controller = undefined; }
  }
}
