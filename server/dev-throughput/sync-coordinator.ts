// 収集の実行を 1 本に絞り、 状態 (実行中・最後の結果) を持つ。 定期実行の timer もここが持つ。

import type { SyncStatus } from './types.js';
import type { CollectResult } from './collect.js';

export class DevThroughputSyncCoordinator {
  #status: SyncStatus = { running: false, lastStartedAt: null, lastFinishedAt: null, lastError: null };
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly run: () => Promise<CollectResult>, private readonly now: () => Date = () => new Date()) {}

  status(): SyncStatus {
    return { ...this.#status };
  }

  /** 実行中なら新しく始めず今の状態を返す。 完了を待たない。 */
  start(): SyncStatus {
    if (!this.#status.running) void this.runOnce();
    return this.status();
  }

  async runOnce(): Promise<void> {
    if (this.#status.running) return;
    this.#status = { ...this.#status, running: true, lastStartedAt: this.now().toISOString() };
    let lastError: string | null = null;
    try {
      const result = await this.run();
      lastError = result.errors.length ? result.errors.join(' / ') : null;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    this.#status = { ...this.#status, running: false, lastFinishedAt: this.now().toISOString(), lastError };
    if (lastError) console.warn(`[dev-throughput] ${lastError}`);
  }

  schedule(intervalMs: number): void {
    this.stop();
    this.#timer = setInterval(() => void this.runOnce(), intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
