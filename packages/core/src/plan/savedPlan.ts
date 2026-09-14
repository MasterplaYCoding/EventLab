import { fixtureDigest } from "../internal/digest.js";
import { HarnessError } from "../errors.js";
import { PLANNER_VERSION } from "../version.js";
import type { DeliveryPlan, EventFixture } from "../types.js";

/**
 * Serialises a plan for storage next to a bug report.
 *
 * Only the instructions are stored. Payloads stay in the user's fixture module
 * and are identified by digest, so a saved plan never becomes a place where a
 * production-shaped payload accidentally lives.
 */
export function serializePlan(plan: DeliveryPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/**
 * Parses a stored plan and checks it is safe to execute.
 *
 * A saved plan is authoritative: this never re-runs the planner. If the
 * planner version moved on, that is reported rather than papered over, because
 * a regenerated plan is a different experiment.
 */
export function parsePlan(source: string): DeliveryPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (cause) {
    throw new HarnessError(
      "InvalidPlan",
      `saved plan is not valid JSON: ${(cause as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new HarnessError("InvalidPlan", "saved plan must be a JSON object");
  }

  const plan = parsed as Partial<DeliveryPlan>;
  requireString(plan.plannerVersion, "plannerVersion");
  requireString(plan.scenario, "scenario");
  requireString(plan.fixtureDigest, "fixtureDigest");
  if (typeof plan.seed !== "number" || !Number.isInteger(plan.seed)) {
    throw new HarnessError("InvalidPlan", "saved plan is missing an integer seed", "seed");
  }
  // Integer, as createPlan requires. `>= 1` alone let 1.5 through, and
  // `"concurrency": 1e999` - valid JSON that parses to Infinity - ran unbounded.
  if (!Number.isInteger(plan.concurrency) || (plan.concurrency as number) < 1) {
    throw new HarnessError(
      "InvalidPlan",
      "saved plan's concurrency must be a positive integer",
      "concurrency",
    );
  }
  if (!Array.isArray(plan.attempts) || plan.attempts.length === 0) {
    throw new HarnessError("InvalidPlan", "saved plan has no attempts", "attempts");
  }
  // Nothing executes these, but a report embeds the plan and a reader of it is
  // told this is how the plan was built; a record that is not one is a plan
  // that no longer explains itself.
  if (!Array.isArray(plan.transforms)) {
    throw new HarnessError("InvalidPlan", "saved plan's transforms must be an array", "transforms");
  }
  for (const [index, transform] of plan.transforms.entries()) {
    if (
      typeof transform !== "object" ||
      transform === null ||
      typeof transform.kind !== "string" ||
      typeof transform.options !== "object" ||
      transform.options === null ||
      Array.isArray(transform.options)
    ) {
      throw new HarnessError(
        "InvalidPlan",
        "each transform must record a kind and an options object",
        `transforms[${index}]`,
      );
    }
  }

  const attemptIds = new Set<string>();
  for (const [index, attempt] of plan.attempts.entries()) {
    const at = `attempts[${index}]`;
    if (typeof attempt !== "object" || attempt === null) {
      throw new HarnessError("InvalidPlan", "attempts must be objects", at);
    }
    const attemptId = attempt.attemptId;
    const eventId = attempt.eventId;
    requireString(attemptId, `${at}.attemptId`);
    requireString(eventId, `${at}.eventId`);
    if (attemptIds.has(attemptId)) {
      throw new HarnessError("InvalidPlan", `duplicate attempt id "${attemptId}"`, at);
    }
    attemptIds.add(attemptId);
    if (!Number.isInteger(attempt.delayMs) || attempt.delayMs < 0) {
      throw new HarnessError("InvalidPlan", "attempt delays must be non-negative integers", at);
    }
    // The scheduler sorts on order and groups on phase. Neither was checked, so
    // a string or fractional value was accepted and then compared as whatever
    // JavaScript made of it.
    for (const field of ["phase", "order", "copyIndex"] as const) {
      const value: unknown = attempt[field];
      if (!Number.isInteger(value) || (value as number) < 0) {
        throw new HarnessError(
          "InvalidPlan",
          `attempt ${field} must be a non-negative integer`,
          `${at}.${field}`,
        );
      }
    }
  }

  // Required, not optional. Every planner-2 plan has it - an empty array when
  // there are no barriers - and runPlan reads it unconditionally, so a plan
  // without it passed here and then crashed replay with an "Unknown" harness
  // error. Found by savedPlanFuzz.test.ts.
  if (!Array.isArray(plan.barriers)) {
    throw new HarnessError("InvalidPlan", "saved plan's barriers must be an array", "barriers");
  }
  {
    const phases = new Set(plan.attempts.map((attempt) => attempt.phase));
    for (const [index, barrier] of plan.barriers.entries()) {
      const at = `barriers[${index}]`;
      requireString(barrier?.name, `${at}.name`);
      if (!Number.isInteger(barrier.afterPhase) || barrier.afterPhase < 0) {
        throw new HarnessError("InvalidPlan", "barrier afterPhase must be a phase index", at);
      }
      if (barrier.checkpoint !== undefined && typeof barrier.checkpoint !== "string") {
        throw new HarnessError("InvalidPlan", "barrier checkpoint must be a hook name", at);
      }
      // A barrier separating nothing from nothing would silently do nothing at
      // run time, which is a saved plan that no longer means what it says.
      if (!phases.has(barrier.afterPhase)) {
        throw new HarnessError(
          "InvalidPlan",
          `barrier "${barrier.name}" follows phase ${barrier.afterPhase}, which has no attempts`,
          at,
        );
      }
    }
  }

  if (plan.plannerVersion !== PLANNER_VERSION) {
    throw new HarnessError(
      "InvalidPlan",
      `saved plan was produced by planner version ${plan.plannerVersion}, but this ` +
        `build understands version ${PLANNER_VERSION}. Replay the plan with a matching ` +
        `EventLab release; regenerating it would run a different experiment.`,
      "plannerVersion",
    );
  }

  return plan as DeliveryPlan;
}

/**
 * Confirms the fixtures on disk still match the ones the plan was built from.
 *
 * Without this check, editing a fixture body would quietly turn a saved
 * reproduction into an unrelated test that happens to share a file name.
 */
export function assertFixturesMatch(plan: DeliveryPlan, events: readonly EventFixture[]): void {
  const actual = fixtureDigest(events);
  if (actual !== plan.fixtureDigest) {
    throw new HarnessError(
      "FixtureDigestMismatch",
      `fixtures have changed since this plan was saved (plan: ${plan.fixtureDigest}, ` +
        `current: ${actual})`,
      "events",
    );
  }

  const known = new Set(events.map((event) => event.id));
  for (const attempt of plan.attempts) {
    if (!known.has(attempt.eventId)) {
      throw new HarnessError(
        "MissingFixture",
        `saved plan references event "${attempt.eventId}", which the supplied fixtures ` +
          `do not define`,
        "events",
      );
    }
  }
}

function requireString(value: unknown, at: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HarnessError("InvalidPlan", `saved plan is missing "${at}"`, at);
  }
}
