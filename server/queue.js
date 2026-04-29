/**
 * Promise-chained FIFO queue. Tasks run strictly one at a time in submission order.
 * Each item is tracked with its metadata, status, and timing so the queue can be
 * inspected from the outside.
 *
 * A task's exception is surfaced into history but does not break the chain.
 */
export class FifoQueue {
  constructor({ historyLimit = 50 } = {}) {
    this.items = [];        // queued + running items (head is currently running once it starts)
    this.history = [];      // completed items, newest first
    this.historyLimit = historyLimit;
    this._chain = Promise.resolve();
    this._nextSeq = 1;
  }

  enqueue(fn, meta = {}) {
    const item = {
      seq: this._nextSeq++,
      ...meta,
      status: 'queued',         // queued | running | done | error
      enqueuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    this.items.push(item);

    const wrapped = async () => {
      item.status = 'running';
      item.startedAt = Date.now();
      try {
        await fn();
        item.status = 'done';
      } catch (e) {
        item.status = 'error';
        item.error = e?.message ?? String(e);
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

  get depth() { return this.items.length; }
  get running() { return this.items.length > 0 && this.items[0].status === 'running'; }

  snapshot() {
    return {
      depth: this.depth,
      running: this.running,
      items: this.items.map(toPlain),
      history: this.history.map(toPlain),
    };
  }
}

function toPlain(item) {
  return { ...item };
}

/**
 * Concurrent task pool. Runs up to `concurrency` tasks in parallel.
 * Same metadata + history shape as FifoQueue, but `running` reflects whether
 * at least one slot is busy (not just the head).
 */
export class ConcurrentPool {
  constructor({ concurrency = 4, historyLimit = 50 } = {}) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.queued = [];
    this._runningSet = new Set();
    this.history = [];
    this.historyLimit = historyLimit;
    this._nextSeq = 1;
  }

  enqueue(fn, meta = {}) {
    const item = {
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

  _tryStart() {
    while (this._runningSet.size < this.concurrency && this.queued.length > 0) {
      const { item, fn } = this.queued.shift();
      this._runningSet.add(item);
      item.status = 'running';
      item.startedAt = Date.now();
      Promise.resolve()
        .then(() => fn())
        .then(
          () => { item.status = 'done'; },
          (e) => {
            item.status = 'error';
            item.error = e?.message ?? String(e);
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

  get depth() { return this.queued.length + this._runningSet.size; }
  get running() { return this._runningSet.size > 0; }

  snapshot() {
    return {
      depth: this.depth,
      running: this.running,
      concurrency: this.concurrency,
      items: [...this._runningSet, ...this.queued.map(q => q.item)].map(toPlain),
      history: this.history.map(toPlain),
    };
  }
}
