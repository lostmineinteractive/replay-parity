/**
 * Emits items in reservation order even when they complete out of order.
 * The proxy reserves a slot when a request arrives and completes it when the
 * upstream response has been forwarded, so the recording stays in arrival
 * order and `offset_ms` never decreases.
 */
export class OrderedSink<T> {
  private nextSeq = 0;
  private flushSeq = 0;
  private readonly slots = new Map<number, T | null>();
  private chain: Promise<void> = Promise.resolve();
  private waiters: (() => void)[] = [];

  constructor(
    private readonly emit: (item: T) => Promise<void>,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  reserve(): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    return seq;
  }

  /** Completes a slot. `null` means the slot produced nothing to emit. */
  complete(seq: number, item: T | null): Promise<void> {
    if (seq < this.flushSeq || seq >= this.nextSeq || this.slots.has(seq)) {
      return Promise.reject(new Error(`slot ${seq} is not pending`));
    }
    this.slots.set(seq, item);
    this.chain = this.chain.then(() => this.flush());
    return this.chain;
  }

  get pending(): number {
    return this.nextSeq - this.flushSeq;
  }

  /** Resolves once every reserved slot has completed and been flushed. */
  idle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private async flush(): Promise<void> {
    while (this.slots.has(this.flushSeq)) {
      const item = this.slots.get(this.flushSeq) as T | null;
      this.slots.delete(this.flushSeq);
      this.flushSeq += 1;
      if (item !== null) {
        try {
          await this.emit(item);
        } catch (err) {
          this.onError(err);
        }
      }
    }
    if (this.pending === 0) {
      for (const resolve of this.waiters.splice(0)) resolve();
    }
  }
}
