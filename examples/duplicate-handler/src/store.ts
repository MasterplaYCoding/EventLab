/**
 * A deliberately tiny in-memory stand-in for the storage a real payment
 * webhook handler would use.
 *
 * The `await` inside every operation is not decoration. It is the point: it
 * makes this store behave like something that goes over a socket, so a
 * check-then-act sequence has a real suspension point in the middle where
 * another delivery can interleave. Without it, single-threaded JavaScript
 * would hide the bug this example exists to demonstrate.
 */
export class OrderStore {
  private readonly fulfillments = new Set<string>();
  private readonly processedEvents = new Set<string>();
  /** Total fulfilment writes, including the duplicates we want to catch. */
  private writes = 0;

  async hasFulfillment(orderId: string): Promise<boolean> {
    await tick();
    return this.fulfillments.has(orderId);
  }

  async recordFulfillment(orderId: string): Promise<void> {
    await tick();
    this.writes += 1;
    this.fulfillments.add(orderId);
  }

  /**
   * Records a fulfilment only if the order has none, in one indivisible step.
   *
   * This is the in-memory equivalent of a unique constraint on `order_id`, or
   * of `INSERT ... ON CONFLICT DO NOTHING`. There is no suspension point
   * between the check and the write, so no delivery can interleave into it.
   */
  async recordFulfillmentOnce(orderId: string): Promise<boolean> {
    await tick();
    if (this.fulfillments.has(orderId)) {
      return false;
    }
    this.writes += 1;
    this.fulfillments.add(orderId);
    return true;
  }

  /** Claims an event id, returning false if it was already claimed. */
  async claimEvent(eventId: string): Promise<boolean> {
    await tick();
    if (this.processedEvents.has(eventId)) {
      return false;
    }
    this.processedEvents.add(eventId);
    return true;
  }

  fulfillmentCount(): number {
    return this.fulfillments.size;
  }

  writeCount(): number {
    return this.writes;
  }

  reset(): void {
    this.fulfillments.clear();
    this.processedEvents.clear();
    this.writes = 0;
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
