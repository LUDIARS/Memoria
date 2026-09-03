// 巡回・サジェスト生成の single-flight。 手動実行 (画面 / Discord) と
// 週次スケジューラが重なっても外部 API を二重に叩かないようにする。

export type BooksJobKind = 'new_release' | 'suggest' | 'enrich';

export type BooksJobRequest<T> =
  | { status: 'started'; promise: Promise<T> }
  | { status: 'busy'; promise: Promise<T> };

export class BooksJobCoordinator {
  private running = new Map<BooksJobKind, Promise<unknown>>();

  request<T>(kind: BooksJobKind, run: () => Promise<T>): BooksJobRequest<T> {
    const current = this.running.get(kind);
    if (current) return { status: 'busy', promise: current as Promise<T> };
    const promise = run().finally(() => { this.running.delete(kind); });
    this.running.set(kind, promise);
    return { status: 'started', promise };
  }
}

export const booksJobCoordinator = new BooksJobCoordinator();
