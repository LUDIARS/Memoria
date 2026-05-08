/**
 * Promise-chained FIFO queue. Tasks run strictly one at a time in submission order.
 * Each item is tracked with its metadata, status, and timing so the queue can be
 * inspected from the outside.
 *
 * A task's exception is surfaced into history but does not break the chain.
 */

export type QueueStatus = 'queued' | 'running' | 'done' | 'error';

/** 任意のメタデータ。 kind / id / title など caller が自由に乗せて UI 側で表示する。 */
export type QueueMeta = Record<string, unknown> & { kind?: string };

export interface QueueItem extends QueueMeta {
  seq: number;
  status: QueueStatus;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

export interface QueueSnapshot {
  depth: number;
  running: boolean;
  items: QueueItem[];
  history: QueueItem[];
  concurrency?: number;
}

export interface QueueOptions {
  historyLimit?: number;
}

export interface PoolOptions extends QueueOptions {
  concurrency?: number;
}

export class FifoQueue {
  items: QueueItem[] = [];
  history: QueueItem[] = [];
  historyLimit: number;
  private _chain: Promise<unknown> = Promise.resolve();
  private _nextSeq = 1;

  constructor({ historyLimit = 50 }: QueueOptions = {}) {
    this.historyLimit = historyLimit;
  }

  enqueue(fn: () => unknown | Promise<unknown>, meta: QueueMeta = {}): Promise<unknown> {
    const item: QueueItem = {
      seq: this._nextSeq++,
      ...meta,
      status: 'queued',
      enqueuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    this.items.push(item);

    const wrapped = async (): Promise<void> => {
      item.status = 'running';
      item.startedAt = Date.now();
      try {
        await fn();
        item.status = 'done';
      } catch (e: unknown) {
        item.status = 'error';
        item.error = errorMessage(e);
        console.error(`[queue] task ${item.kind ?? ''}#${item.seq} failed:`, item.error);
      } finally {
        item.finishedAt = Date.now();
        const idx = this.items.indexOf(item);
        if (idx >= 0) this.items.splice(idx, 1);
        this.history.unshift(item);
        if (this.history.length > this.historyLimit) {
          this.history.length = this.historyLimit;
        }
      }
    };
    this._chain = this._chain.then(wrapped);
    return this._chain;
  }

  get depth(): number { return this.items.length; }
  get running(): boolean { return this.items.length > 0 && this.items[0].status === 'running'; }

  snapshot(): QueueSnapshot {
    return {
      depth: this.depth,
      running: this.running,
      items: this.items.map(toPlain),
      history: this.history.map(toPlain),
    };
  }
}

function toPlain(item: QueueItem): QueueItem {
  return { ...item };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Concurrent task pool. Runs up to `concurrency` tasks in parallel.
 * Same metadata + history shape as FifoQueue, but `running` reflects whether
 * at least one slot is busy (not just the head).
 */
export class ConcurrentPool {
  concurrency: number;
  historyLimit: number;
  history: QueueItem[] = [];
  private queued: { item: QueueItem; fn: () => unknown | Promise<unknown> }[] = [];
  private _runningSet = new Set<QueueItem>();
  private _nextSeq = 1;

  constructor({ concurrency = 4, historyLimit = 50 }: PoolOptions = {}) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.historyLimit = historyLimit;
  }

  enqueue(fn: () => unknown | Promise<unknown>, meta: QueueMeta = {}): void {
    const item: QueueItem = {
      seq: this._nextSeq++,
      ...meta,
      status: 'queued',
      enqueuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    this.queued.push({ item, fn });
    this._tryStart();
  }

  private _tryStart(): void {
    while (this._runningSet.size < this.concurrency && this.queued.length > 0) {
      const next = this.queued.shift();
      if (!next) break;
      const { item, fn } = next;
      this._runningSet.add(item);
      item.status = 'running';
      item.startedAt = Date.now();
      Promise.resolve()
        .then(() => fn())
        .then(
          () => { item.status = 'done'; },
          (e: unknown) => {
            item.status = 'error';
            item.error = errorMessage(e);
            console.error(`[pool] task ${item.kind ?? ''}#${item.seq} failed:`, item.error);
          },
        )
        .finally(() => {
          item.finishedAt = Date.now();
          this._runningSet.delete(item);
          this.history.unshift(item);
          if (this.history.length > this.historyLimit) this.history.length = this.historyLimit;
          this._tryStart();
        });
    }
  }

  get depth(): number { return this.queued.length + this._runningSet.size; }
  get running(): boolean { return this._runningSet.size > 0; }

  snapshot(): QueueSnapshot {
    return {
      depth: this.depth,
      running: this.running,
      concurrency: this.concurrency,
      items: [...this._runningSet, ...this.queued.map(q => q.item)].map(toPlain),
      history: this.history.map(toPlain),
    };
  }
}
