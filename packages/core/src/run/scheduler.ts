import type { DeliveryAttempt } from "../types.js";

export interface ScheduleOptions {
  readonly attempts: readonly DeliveryAttempt[];
  readonly concurrency: number;
  /** Monotonic reading, in milliseconds, for the start of this phase. */
  readonly startedAt: number;
  /** Elapsed milliseconds since the run began, for reporting. */
  readonly runStartedAt: number;
  readonly signal: AbortSignal;
  /** Invoked once per attempt, at its release point. */
  readonly execute: (attempt: DeliveryAttempt, observedStartMs: number) => Promise<void>;
}

/**
 * Releases attempts according to their planned offsets, under a concurrency
 * limit, and waits for everything in flight to settle.
 *
 * Rules, in the order they apply:
 *
 * 1. Attempts are released in `(delayMs, order)` order. Plan order is the
 *    tie-break, so two attempts planned for the same instant always contend in
 *    the same sequence across runs.
 * 2. An attempt waits for a free slot before it waits for its clock offset.
 *    A saturated run therefore *slips* rather than bursting to catch up, and
 *    the report shows the slip as the gap between intended and observed start.
 * 3. Cancellation stops releasing new attempts. Attempts already in flight are
 *    aborted by the shared signal, and the caller still runs teardown.
 *
 * Elapsed time comes from `performance.now()`, which is monotonic, so a system
 * clock adjustment mid-run cannot make an attempt appear to start before the
 * run did.
 */
export async function schedule(options: ScheduleOptions): Promise<void> {
  const { concurrency, startedAt, runStartedAt, signal, execute } = options;

  const ordered = [...options.attempts].sort(
    (a, b) => a.delayMs - b.delayMs || a.order - b.order,
  );

  const inFlight = new Set<Promise<void>>();

  for (const attempt of ordered) {
    if (signal.aborted) {
      break;
    }

    while (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
    }

    await sleepUntil(startedAt + attempt.delayMs, signal);
    if (signal.aborted) {
      break;
    }

    // Reported relative to the run, not the phase, so a report reads as one
    // timeline even when barriers restarted the offset clock.
    const observedStartMs = performance.now() - runStartedAt;
    const running = execute(attempt, observedStartMs).finally(() => {
      inFlight.delete(running);
    });
    inFlight.add(running);
  }

  await Promise.all(inFlight);
}

/** Waits until the monotonic deadline, or until cancellation, whichever first. */
function sleepUntil(deadline: number, signal: AbortSignal): Promise<void> {
  const remaining = deadline - performance.now();
  if (remaining <= 0 || signal.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, remaining);

    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
