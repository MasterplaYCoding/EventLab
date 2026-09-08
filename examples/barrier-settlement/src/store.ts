/**
 * An order ledger with an asynchronous settlement worker.
 *
 * The shape is deliberately ordinary: a request enqueues work and returns
 * quickly, a background worker applies it, and something else reads the
 * result. That gap between "accepted" and "applied" is where a whole family
 * of bugs lives, and it is the gap a barrier lets a test address directly.
 */
export class Ledger {
  /** Authoritative balances, written only by the worker. */
  private readonly settled = new Map<string, number>();
  /** Lowest balance each order has ever held. See lowestBalance(). */
  private readonly low = new Map<string, number>();
  /** Events already applied, so a redelivery settles once. */
  private readonly appliedEvents = new Set<string>();
  /** Work the worker has accepted but not yet applied. */
  private readonly queue: Array<{ eventId: string; orderId: string; amount: number }> = [];

  private draining = false;

  /** Set while settlement is deliberately held; see pauseSettlement(). */
  private held: Promise<void> | null = null;
  private release: (() => void) | null = null;

  /**
   * Holds the worker: it accepts work and applies none of it.
   *
   * This is how a test puts the system into the state "settlement has not
   * finished yet" and *keeps* it there, rather than delivering quickly and
   * hoping to win a race. Whether a refund overtakes a background worker is
   * decided by the event loop, the OS and the machine — the first version of
   * this example's tests hoped it would, which worked on Windows and never
   * happened on Linux.
   *
   * A real application has the same lever somewhere: pause the consumer, stop
   * the worker container, hold the lock.
   */
  pauseSettlement(): void {
    if (this.held !== null) {
      return;
    }
    this.held = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  /** Lets a held worker continue. */
  resumeSettlement(): void {
    this.release?.();
    this.release = null;
    this.held = null;
  }

  /** Accepts work and returns immediately, as a real endpoint would. */
  enqueue(eventId: string, orderId: string, amount: number): void {
    this.queue.push({ eventId, orderId, amount });
    void this.drain();
  }

  /**
   * Applies queued work one item at a time, yielding between each.
   *
   * The yield is what makes settlement observably asynchronous: a request that
   * arrives while the queue is draining sees a partially applied ledger.
   */
  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;

    try {
      while (this.queue.length > 0) {
        await tick();
        if (this.held !== null) {
          await this.held;
        }
        const item = this.queue.shift();
        if (item === undefined) {
          break;
        }
        // Settling is idempotent per event id, so duplicate deliveries of the
        // same payment do not credit the order twice. That is not the bug this
        // example is about.
        if (this.appliedEvents.has(item.eventId)) {
          continue;
        }
        this.appliedEvents.add(item.eventId);
        this.setBalance(item.orderId, this.balance(item.orderId) + item.amount);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Resolves once the worker has nothing left to do.
   *
   * This is what a barrier's checkpoint waits for. A real application would
   * expose the same thing — a queue-depth endpoint, a test-only hook, a
   * `waitForIdle` on its job runner. The point is that the *application*
   * decides when it is quiescent, rather than the test guessing with a sleep.
   */
  async whenSettled(): Promise<void> {
    while (this.queue.length > 0 || this.draining) {
      await tick();
    }
  }

  /** True once this order has any settled balance. */
  isSettled(orderId: string): boolean {
    return this.settled.has(orderId);
  }

  balance(orderId: string): number {
    return this.settled.get(orderId) ?? 0;
  }

  /**
   * Claims a refund event id, returning false if it was already applied.
   *
   * Both handlers use this, so duplicate delivery is not what separates them.
   * The difference this example is about is *ordering*, and leaving a
   * duplicate-processing bug in either handler would muddle that.
   */
  claimRefund(eventId: string): boolean {
    if (this.appliedEvents.has(eventId)) {
      return false;
    }
    this.appliedEvents.add(eventId);
    return true;
  }

  /** Applies a refund directly against the settled balance. */
  applyRefund(orderId: string, amount: number): void {
    this.setBalance(orderId, this.balance(orderId) - amount);
  }

  /**
   * The lowest balance this order has *ever* held.
   *
   * Recorded because the interesting failure here is transient: a refund
   * applied before its payment settles drives the balance negative, and the
   * payment settling afterwards brings it back to zero. An assertion that only
   * looked at the final state would see nothing wrong, having missed the
   * window in which the ledger said a customer was owed money nobody had taken
   * from them.
   */
  lowestBalance(orderId: string): number {
    return this.low.get(orderId) ?? 0;
  }

  private setBalance(orderId: string, amount: number): void {
    this.settled.set(orderId, amount);
    this.low.set(orderId, Math.min(this.low.get(orderId) ?? 0, amount));
  }

  reset(): void {
    this.resumeSettlement();
    this.settled.clear();
    this.low.clear();
    this.appliedEvents.clear();
    this.queue.length = 0;
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
