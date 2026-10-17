import { setImmediate } from 'node:timers';
import type { BusHandler, MessageBus } from './bus.js';

/** A bus for one process. Delivery is asynchronous, like a network, and in publish order. */
export class InProcessBus implements MessageBus {
  private readonly handlers = new Map<string, Set<BusHandler>>();
  private closed = false;

  publish(topic: string, payload: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('bus is closed'));
    const subscribers = this.handlers.get(topic);
    if (subscribers) {
      for (const handler of [...subscribers]) {
        setImmediate(() => {
          void Promise.resolve()
            .then(() => handler(payload))
            .catch(() => undefined);
        });
      }
    }
    return Promise.resolve();
  }

  subscribe(topic: string, handler: BusHandler): Promise<() => Promise<void>> {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler);
    return Promise.resolve(() => {
      set.delete(handler);
      return Promise.resolve();
    });
  }

  close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
    return Promise.resolve();
  }
}
