/**
 * A fixed set of items handed out one holder at a time. `use` waits for a free
 * item, runs the work, and gives the item back, so several attempts can run at
 * once as long as each holds a different candidate target.
 */
export class Pool<T> {
  private readonly free: T[];
  private readonly waiters: ((item: T) => void)[] = [];

  constructor(items: readonly T[]) {
    this.free = [...items];
  }

  get size(): number {
    return this.free.length;
  }

  private acquire(): Promise<T> {
    const item = this.free.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }

  private release(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.free.push(item);
    else waiter(item);
  }

  async use<R>(work: (item: T) => Promise<R>): Promise<R> {
    const item = await this.acquire();
    try {
      return await work(item);
    } finally {
      this.release(item);
    }
  }
}
