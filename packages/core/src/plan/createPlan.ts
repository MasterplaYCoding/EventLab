import { createRng } from "../internal/random.js";
import { fixtureDigest } from "../internal/digest.js";
import { HarnessError } from "../errors.js";
import { PLANNER_VERSION } from "../version.js";
import type { DeliveryPlan, EventFixture } from "../types.js";
import { finalise, type AttemptDraft, type Transform } from "./transforms.js";

const MAX_EVENT_ID_LENGTH = 200;
const DEFAULT_CONCURRENCY = 4;

export interface CreatePlanOptions {
  /** Names the scenario in reports. Defaults to `"scenario"`. */
  readonly scenario?: string;
  readonly events: readonly EventFixture[];
  /** Any 32-bit integer. The same seed and inputs always expand identically. */
  readonly seed: number;
  /** Applied in declaration order. */
  readonly transforms?: readonly Transform[];
  /** Maximum attempts in flight at once. Defaults to 4. */
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
    transforms = [],
    concurrency = DEFAULT_CONCURRENCY,
  } = options;

  validateSeed(seed);
  validateConcurrency(concurrency);
  validateEvents(events);

  const rng = createRng(seed);
  let drafts: AttemptDraft[] = events.map((event) => ({
    eventId: event.id,
    copyIndex: 0,
    delayMs: 0,
  }));

  for (const [index, transform] of transforms.entries()) {
    drafts = transform.apply(drafts, rng);
    assertDraftsReferenceKnownEvents(drafts, events, transform.record.kind, index);
  }

  return {
    plannerVersion: PLANNER_VERSION,
    scenario,
    seed,
    fixtureDigest: fixtureDigest(events),
    concurrency,
    transforms: transforms.map((transform) => transform.record),
    attempts: finalise(drafts),
  };
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

function assertDraftsReferenceKnownEvents(
  drafts: readonly AttemptDraft[],
  events: readonly EventFixture[],
  kind: string,
  index: number,
): void {
  const known = new Set(events.map((event) => event.id));
  for (const draft of drafts) {
    if (!known.has(draft.eventId)) {
      throw new HarnessError(
        "InvalidPlan",
        `transform "${kind}" produced an attempt for unknown event "${draft.eventId}"`,
        `transforms[${index}]`,
      );
    }
    if (!Number.isInteger(draft.delayMs) || draft.delayMs < 0) {
      throw new HarnessError(
        "InvalidPlan",
        `transform "${kind}" produced a negative or non-integer delay`,
        `transforms[${index}]`,
      );
    }
  }
}
