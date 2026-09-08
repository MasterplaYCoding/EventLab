/**
 * EventLab: reproducible tests for duplicate, delayed, reordered and
 * concurrent event delivery.
 *
 * The library never imports a test runner. Use it from whichever runner the
 * project already has.
 */

export { createPlan, type CreatePlanOptions } from "./plan/createPlan.js";
export {
  burst,
  delay,
  duplicate,
  shuffle,
  type AttemptDraft,
  type Transform,
} from "./plan/transforms.js";
export { assertFixturesMatch, parsePlan, serializePlan } from "./plan/savedPlan.js";
export { runPlan } from "./run/runPlan.js";
export { HarnessError, isHarnessError, type HarnessErrorCode } from "./errors.js";
export { PLANNER_VERSION, REPORT_SCHEMA_VERSION } from "./version.js";
export {
  countDeliveries,
  deliveriesFor,
  summariseStatuses,
} from "./report/summary.js";
export {
  assertRunPassed,
  formatReport,
  type FormatReportOptions,
} from "./report/format.js";

export type {
  Assertion,
  AssertionContext,
  AssertionReport,
  AttemptReport,
  CheckAssertion,
  DeliveryAttempt,
  DeliveryExpectation,
  DeliveryOutcome,
  DeliveryPlan,
  EventFixture,
  EventuallyAssertion,
  HttpRequestSpec,
  HttpTarget,
  RequestContext,
  RunLimits,
  RunOptions,
  RunReport,
  ScenarioHooks,
  TransformRecord,
} from "./types.js";
