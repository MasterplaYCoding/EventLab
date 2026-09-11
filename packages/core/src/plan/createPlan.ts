import { createRng } from "../internal/random.js";
import { fixtureDigest } from "../internal/digest.js";
import { HarnessError } from "../errors.js";
import { PLANNER_VERSION } from "../version.js";
import type { DeliveryAttempt, DeliveryPlan, EventFixture, PlanBarrier } from "../types.js";
import { finalise, type AttemptDraft, type Transform } from "./transforms.js";

const MAX_EVENT_ID_LENGTH = 200;
const DEFAULT_CONCURRENCY = 4;

/** One group of deliveries, or a barrier between two groups. */
export type PlanPhase =
  | {
      /** Ids of the events delivered in this phase. Must exist in `events`. */
      readonly deliver: readonly string[];
      /** Applied to this phase only, in declaration order. */
      readonly transforms?: readonly Transform[];
    }
  | {
      /**
       * A synchronisation point. Everything before it completes before
       * anything after it is released.
       */
      readonly barrier: string;
      /** Key in `ScenarioHooks.checkpoints`, awaited when the barrier is hit. */
      readonly checkpoint?: string;
    };

export interface CreatePlanOptions {
  /** Names the scenario in reports. Defaults to `"scenario"`. */
  readonly scenario?: string;
  /** Every fixture the scenario can deliver. */
  readonly events: readonly EventFixture[];
  /** Any 32-bit integer. The same seed and inputs always expand identically. */
  readonly seed: number;
  /**
   * Applied to all events, in declaration order.
   *
   * Mutually exclusive with {@link CreatePlanOptions.phases}: a single-phase plan is the common
   * case and does not need the ceremony.
   */
  readonly transforms?: readonly Transform[];
  /**
   * Ordered phases and barriers, for scenarios that need a synchronisation
   * point partway through.
   *
   * ```ts
   * phases: [
   *   { deliver: ["evt_payment"], transforms: [duplicate({ copies: 3 })] },
   *   { barrier: "worker drained", checkpoint: "drainWorker" },
   *   { deliver: ["evt_refund"] },
   * ]
   * ```
   */
  readonly phases?: readonly PlanPhase[];
  /** Maximum attempts in flight at once, within a phase. Defaults to 4. */
  readonly concurrency?: number;
}

/**
 * Expands a scenario into a concrete, serialisable {@link DeliveryPlan}.
 *
 * All validation happens here, before anything touches the network, so an
 * invalid scenario fails as a harness error rather than as a confusing pile of
 * transport failures. Every random choice is drawn during this call.
 */
export function createPlan(options: CreatePlanOptions): DeliveryPlan {
  const {
    scenario = "scenario",
    events,
    seed,
    transforms,
    phases,
    concurrency = DEFAULT_CONCURRENCY,
  } = options;

  validateSeed(seed);
  validateConcurrency(concurrency);
  validateEvents(events);

  if (phases !== undefined && transforms !== undefined) {
    throw new HarnessError(
      "InvalidScenario",
      "pass either transforms (one phase) or phases (several), not both",
      "phases",
    );
  }

  const declared: readonly PlanPhase[] =
    phases ?? [{ deliver: events.map((event) => event.id), ...(transforms ? { transforms } : {}) }];

  if (declared.length === 0) {
    throw new HarnessError("InvalidScenario", "a scenario needs at least one phase", "phases");
  }

  const rng = createRng(seed);
  const known = new Set(events.map((event) => event.id));
  const attempts: DeliveryAttempt[] = [];
  const barriers: PlanBarrier[] = [];
  const recordedTransforms = [];

  let phaseIndex = 0;
  let orderBase = 0;
  let delivered = false;

  for (const [index, phase] of declared.entries()) {
    if ("barrier" in phase) {
      validateBarrier(phase, index, delivered, barriers);
      barriers.push({
        name: phase.barrier,
        // A barrier follows the phase currently being filled, and the next
        // delivery phase begins after it.
        afterPhase: phaseIndex,
        ...(phase.checkpoint === undefined ? {} : { checkpoint: phase.checkpoint }),
      });
      phaseIndex += 1;
      delivered = false;
      continue;
    }

    validateDeliverList(phase.deliver, known, index);

    let drafts: AttemptDraft[] = phase.deliver.map((eventId) => ({
      eventId,
      copyIndex: 0,
      delayMs: 0,
    }));

    for (const [step, transform] of (phase.transforms ?? []).entries()) {
      drafts = transform.apply(drafts, rng);
      assertDraftsAreValid(drafts, known, transform.record.kind, `phases[${index}].transforms[${step}]`);
      recordedTransforms.push(transform.record);
    }

    const finalised = finalise(drafts, { phase: phaseIndex, orderBase, existing: attempts });
    attempts.push(...finalised);
    orderBase += finalised.length;
    delivered = true;
  }

  if (attempts.length === 0) {
    throw new HarnessError(
      "InvalidScenario",
      "a scenario must deliver at least one event",
      "phases",
    );
  }

  return {
    plannerVersion: PLANNER_VERSION,
    scenario,
    seed,
    fixtureDigest: fixtureDigest(events),
    concurrency,
    transforms: recordedTransforms,
    attempts,
    barriers,
  };
}

function validateBarrier(
  phase: { readonly barrier: string; readonly checkpoint?: string },
  index: number,
  delivered: boolean,
  existing: readonly PlanBarrier[],
): void {
  const at = `phases[${index}]`;

  if (typeof phase.barrier !== "string" || phase.barrier.trim().length === 0) {
    throw new HarnessError("InvalidScenario", "a barrier needs a non-empty name", at);
  }
  if (existing.some((barrier) => barrier.name === phase.barrier)) {
    // Barriers are reported by name, so duplicates would make a report
    // ambiguous about which one was reached.
    throw new HarnessError(
      "InvalidScenario",
      `duplicate barrier name "${phase.barrier}"`,
      at,
    );
  }
  if (!delivered) {
    // A barrier with nothing before it waits for nothing, and two in a row is
    // almost always a mistake in how the phases were written.
    throw new HarnessError(
      "InvalidScenario",
      `barrier "${phase.barrier}" has no deliveries before it to wait for`,
      at,
    );
  }
  if (phase.checkpoint !== undefined && phase.checkpoint.length === 0) {
    throw new HarnessError("InvalidScenario", "checkpoint names must be non-empty", at);
  }
}

function validateDeliverList(
  deliver: readonly string[],
  known: ReadonlySet<string>,
  index: number,
): void {
  const at = `phases[${index}].deliver`;

  if (!Array.isArray(deliver) || deliver.length === 0) {
    throw new HarnessError("InvalidScenario", "a delivery phase needs at least one event", at);
  }

  const seen = new Set<string>();
  for (const eventId of deliver) {
    if (!known.has(eventId)) {
      throw new HarnessError(
        "InvalidScenario",
        `phase delivers unknown event "${eventId}"; add it to events`,
        at,
      );
    }
    if (seen.has(eventId)) {
      // Deliver it twice with duplicate({ copies: 2 }), which records the
      // intent in the plan; listing it twice hides that.
      throw new HarnessError(
        "InvalidScenario",
        `event "${eventId}" is listed twice in one phase; use duplicate() instead`,
        at,
      );
    }
    seen.add(eventId);
  }
}

function validateSeed(seed: number): void {
  if (!Number.isInteger(seed)) {
    throw new HarnessError(
      "InvalidScenario",
      `seed must be an integer, received ${String(seed)}`,
      "seed",
    );
  }
}

function validateConcurrency(concurrency: number): void {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new HarnessError(
      "InvalidScenario",
      `concurrency must be a positive integer, received ${String(concurrency)}`,
      "concurrency",
    );
  }
}

function validateEvents(events: readonly EventFixture[]): void {
  if (events.length === 0) {
    throw new HarnessError("InvalidScenario", "a scenario needs at least one event", "events");
  }

  const seen = new Set<string>();
  for (const [index, event] of events.entries()) {
    const at = `events[${index}].id`;
    if (typeof event.id !== "string" || event.id.length === 0) {
      throw new HarnessError("InvalidScenario", "event ids must be non-empty strings", at);
    }
    if (event.id.length > MAX_EVENT_ID_LENGTH) {
      throw new HarnessError(
        "InvalidScenario",
        `event ids must be at most ${MAX_EVENT_ID_LENGTH} characters`,
        at,
      );
    }
    if (event.id.includes("#")) {
      // Attempt ids are `<eventId>#<copyIndex>`; keeping "#" out of event ids
      // means an attempt id can always be split back apart unambiguously.
      throw new HarnessError("InvalidScenario", 'event ids must not contain "#"', at);
    }
    if (seen.has(event.id)) {
      throw new HarnessError("InvalidScenario", `duplicate event id "${event.id}"`, at);
    }
    seen.add(event.id);
  }
}

function assertDraftsAreValid(
  drafts: readonly AttemptDraft[],
  known: ReadonlySet<string>,
  kind: string,
  at: string,
): void {
  for (const draft of drafts) {
    if (!known.has(draft.eventId)) {
      throw new HarnessError(
        "InvalidPlan",
        `transform "${kind}" produced an attempt for unknown event "${draft.eventId}"`,
        at,
      );
    }
    if (!Number.isInteger(draft.delayMs) || draft.delayMs < 0) {
      throw new HarnessError(
        "InvalidPlan",
        `transform "${kind}" produced a negative or non-integer delay`,
        at,
      );
    }
  }
}
