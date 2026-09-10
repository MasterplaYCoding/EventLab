/**
 * Categories of failure that are the harness's fault rather than the
 * application under test's fault. These are always reported separately from
 * delivery outcomes and assertion outcomes.
 */
export type HarnessErrorCode =
  | "InvalidScenario"
  | "InvalidPlan"
  | "InvalidTarget"
  | "RemoteTargetBlocked"
  | "MissingFixture"
  | "FixtureDigestMismatch"
  | "SetupFailed"
  | "ScenarioTimeout"
  | "Cancelled";

/**
 * Raised when EventLab cannot run a scenario as written. A `HarnessError`
 * never means "the application under test is wrong"; it means the experiment
 * itself was not valid.
 */
export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  /** Optional path-ish pointer to the offending input, e.g. `events[2].id`. */
  readonly at: string | undefined;

  constructor(code: HarnessErrorCode, message: string, at?: string) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    this.at = at;
  }
}

/**
 * Type guard for {@link HarnessError}, safe across realm boundaries.
 *
 * Deliberately not `instanceof`. That compares against *this* realm's `Error`,
 * so an error thrown inside a `node:vm` context, a worker, or any other realm
 * fails the check no matter what it is - which is precisely the case the
 * realm-safety note exists for, and precisely what the previous
 * implementation got wrong. `Object.prototype.toString` is defined on the
 * value's own realm and returns `"[object Error]"` regardless of where the
 * error was constructed.
 *
 * The `code` check narrows what the name alone would let through. Duck typing
 * is the price of realm safety; requiring both fields keeps the price small.
 */
export function isHarnessError(value: unknown): value is HarnessError {
  if (Object.prototype.toString.call(value) !== "[object Error]") return false;
  const candidate = value as { name?: unknown; code?: unknown };
  return candidate.name === "HarnessError" && typeof candidate.code === "string";
}
