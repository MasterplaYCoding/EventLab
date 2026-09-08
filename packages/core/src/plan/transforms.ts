import { shuffleWith, type Rng } from "../internal/random.js";
import { HarnessError } from "../errors.js";
import type { DeliveryAttempt, TransformRecord } from "../types.js";

/**
 * A planning step. Transforms run in declaration order over the current
 * attempt list and may add, remove, reorder or retime attempts.
 *
 * `attemptId` and `order` are assigned by the planner after the whole chain
 * has run, so a transform only has to produce well-formed drafts.
 */
export interface Transform {
  readonly record: TransformRecord;
  readonly apply: (attempts: readonly AttemptDraft[], rng: Rng) => AttemptDraft[];
}

/** A pre-identity attempt: the planner assigns ids and ordering afterwards. */
export interface AttemptDraft {
  readonly eventId: string;
  readonly copyIndex: number;
  readonly delayMs: number;
}

/**
 * Deliver each event `copies` times in total.
 *
 * Copies are appended immediately after their original rather than at the end
 * of the list, so a plan with no other transform reads as a burst of retries
 * for one event. Reordering is the `shuffle` transform's job.
 */
export function duplicate(options: { copies: number }): Transform {
  const { copies } = options;
  if (!Number.isInteger(copies) || copies < 1) {
    throw new HarnessError(
      "InvalidScenario",
      `duplicate({ copies }) requires a positive integer, received ${String(copies)}`,
      "transforms.duplicate.copies",
    );
  }

  return {
    record: { kind: "duplicate", options: { copies } },
    apply: (attempts) =>
      attempts.flatMap((attempt) =>
        Array.from({ length: copies }, (_unused, index) => ({
          eventId: attempt.eventId,
          copyIndex: attempt.copyIndex + index,
          delayMs: attempt.delayMs,
        })),
      ),
  };
}

/**
 * Randomly reorder attempts.
 *
 * Ordering here means plan order, which decides tie-breaks and release order.
 * It does not promise that the target observes requests in that order: once
 * requests are in flight, the network and the application decide.
 */
export function shuffle(): Transform {
  return {
    record: { kind: "shuffle", options: {} },
    apply: (attempts, rng) => shuffleWith(attempts, rng),
  };
}

/**
 * Give each attempt a start offset drawn from `[minMs, maxMs]`.
 *
 * The offset is drawn once, during planning, and stored in the plan. The
 * runner treats it as the *intended* start; the report records what actually
 * happened alongside it.
 */
export function delay(options: { minMs: number; maxMs: number }): Transform {
  const { minMs, maxMs } = options;
  if (!Number.isInteger(minMs) || !Number.isInteger(maxMs) || minMs < 0 || maxMs < minMs) {
    throw new HarnessError(
      "InvalidScenario",
      `delay({ minMs, maxMs }) requires 0 <= minMs <= maxMs, received ${String(minMs)}..${String(maxMs)}`,
      "transforms.delay",
    );
  }

  return {
    record: { kind: "delay", options: { minMs, maxMs } },
    apply: (attempts, rng) =>
      attempts.map((attempt) => ({
        eventId: attempt.eventId,
        copyIndex: attempt.copyIndex,
        delayMs: rng.nextInt(minMs, maxMs),
      })),
  };
}

/**
 * Deliver every attempt at offset zero, so the concurrency limit alone decides
 * how many are in flight. Useful for reproducing lost-update races.
 */
export function burst(): Transform {
  return {
    record: { kind: "burst", options: {} },
    apply: (attempts) =>
      attempts.map((attempt) => ({
        eventId: attempt.eventId,
        copyIndex: attempt.copyIndex,
        delayMs: 0,
      })),
  };
}

/** Assigns final ids and plan order to a finished draft list. */
export function finalise(drafts: readonly AttemptDraft[]): DeliveryAttempt[] {
  const seen = new Map<string, number>();
  return drafts.map((draft, index) => {
    // A transform chain can produce the same (eventId, copyIndex) pair twice -
    // duplicate() applied twice, for instance. Re-index rather than emitting a
    // colliding attempt id, since attempt ids are the join key in reports.
    const nextCopy = seen.get(draft.eventId) ?? 0;
    seen.set(draft.eventId, nextCopy + 1);
    return {
      attemptId: `${draft.eventId}#${nextCopy}`,
      eventId: draft.eventId,
      copyIndex: nextCopy,
      order: index,
      delayMs: draft.delayMs,
    };
  });
}
