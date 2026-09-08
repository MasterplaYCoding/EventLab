/**
 * A deliberately tiny in-memory stand-in for the storage a real payment
 * webhook handler would use.
 *
 * Every operation awaits, so the store behaves like something that goes over a
 * socket rather than something the JavaScript event loop can treat as atomic.
 * The operations that must be indivisible say so, and are.
 */
export class OrderStore {
  private readonly fulfillments = new Set<string>();
  private readonly processedEvents = new Set<string>();
  /** Every fulfilment write, including the duplicates we want to catch. */
  private readonly writes: string[] = [];

  /**
   * Records a fulfilment unconditionally.
   *
   * This is an `INSERT` with no uniqueness behind it. Calling it twice for one
   * order fulfils that order twice.
   */
  async recordFulfillment(orderId: string): Promise<void> {
    await tick();
    this.writes.push(orderId);
    this.fulfillments.add(orderId);
  }

  /**
   * Records a fulfilment only if the order has none, in one indivisible step.
   *
   * The in-memory equivalent of a unique constraint on `order_id`, or of
   * `INSERT ... ON CONFLICT DO NOTHING`. There is no suspension point between
   * the check and the write, so no delivery can interleave into it.
   */
  async recordFulfillmentOnce(orderId: string): Promise<boolean> {
    await tick();
    if (this.fulfillments.has(orderId)) {
      return false;
    }
    this.writes.push(orderId);
    this.fulfillments.add(orderId);
    return true;
  }

  /**
   * Claims an event id, returning false if it was already claimed.
   *
   * Also indivisible: this is the correct way to make *redelivery of the same
   * event* a no-op, and both handlers in this example use it. It is not the
   * part either handler gets wrong.
   */
  async claimEvent(eventId: string): Promise<boolean> {
    await tick();
    if (this.processedEvents.has(eventId)) {
      return false;
    }
    this.processedEvents.add(eventId);
    return true;
  }

  /** Distinct orders fulfilled. */
  fulfillmentCount(): number {
    return this.fulfillments.size;
  }

  /** Total fulfilment writes, duplicates included. */
  writeCount(): number {
    return this.writes.length;
  }

  /** How many times this specific order was fulfilled. */
  writesFor(orderId: string): number {
    return this.writes.filter((written) => written === orderId).length;
  }

  reset(): void {
    this.fulfillments.clear();
    this.processedEvents.clear();
    this.writes.length = 0;
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
