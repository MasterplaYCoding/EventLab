/**
 * A rendezvous that makes a specific concurrent interleaving certain.
 *
 * Some bugs only appear when two requests overlap in a particular way. The
 * tempting way to test for one is to send many duplicates and hope: raise the
 * copy count, run it in CI, and see if the race turns up.
 *
 * That produces a bad test. It passes on one machine and fails on another - a
 * handler with a genuine check-then-act bug produced *no* duplicate writes on
 * Linux and reliable duplicate writes on Windows, from the identical plan -
 * and when it eventually goes green nobody can tell whether the bug was fixed
 * or the scheduler simply moved.
 *
 * So the application under test declares where its window is, and the window
 * is held open deterministically. That is the same principle EventLab applies
 * to crash boundaries: synchronise on a point the application can signal, not
 * on a duration and some optimism.
 *
 * This belongs to the *example*, not to the library. EventLab has no way to
 * reach inside an application and hold a lock open, and should not.
 */
export class InterleavingGate {
  private readonly queues = new Map<string, Array<() => void>>();
  private readonly opened = new Set<string>();

  /**
   * @param participants how many arrivals at a key release it.
   * @param timeoutMs a liveness guard. It never fires in the scenarios here;
   *   if a future change makes a partner impossible, this fails loudly rather
   *   than hanging CI for six hours.
   */
  constructor(
    private readonly participants = 2,
    private readonly timeoutMs = 5_000,
  ) {}

  /**
   * Blocks until `participants` callers have arrived at `key`, then releases
   * all of them together. Later arrivals at an already-opened key pass
   * straight through.
   */
  arrive(key: string): Promise<void> {
    if (this.opened.has(key)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const queue = this.queues.get(key) ?? [];

      const timer = setTimeout(() => {
        reject(
          new Error(
            `interleaving gate '${key}' waited ${this.timeoutMs}ms for ` +
              `${this.participants} participants and only ${queue.length} arrived`,
          ),
        );
      }, this.timeoutMs);

      queue.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.queues.set(key, queue);

      if (queue.length >= this.participants) {
        this.opened.add(key);
        this.queues.delete(key);
        for (const release of queue) {
          release();
        }
      }
    });
  }

  reset(): void {
    this.queues.clear();
    this.opened.clear();
  }
}
