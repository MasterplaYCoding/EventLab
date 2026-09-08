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
  if (typeof plan.concurrency !== "number" || plan.concurrency < 1) {
    throw new HarnessError("InvalidPlan", "saved plan has an invalid concurrency", "concurrency");
  }
  if (!Array.isArray(plan.attempts) || plan.attempts.length === 0) {
    throw new HarnessError("InvalidPlan", "saved plan has no attempts", "attempts");
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
