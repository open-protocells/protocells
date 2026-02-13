import crypto from 'node:crypto';
import type { QueueMessage } from './types.js';

export class MessageQueue {
  private messages: QueueMessage[] = [];
  private waiter: (() => void) | null = null;

  push(content: string, source: string = 'unknown', metadata?: Record<string, unknown>): QueueMessage {
    const msg: QueueMessage = {
      id: crypto.randomUUID(),
      content,
      source,
      timestamp: Date.now(),
      metadata,
    };
    this.messages.push(msg);

    // Wake up if waiting
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve();
    }

    return msg;
  }

  drain(): QueueMessage[] {
    const batch = this.messages.splice(0);
    return batch;
  }

  get pending(): number {
    return this.messages.length;
  }

  waitForMessage(): Promise<void> {
    if (this.messages.length > 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiter = resolve;
    });
  }
}
