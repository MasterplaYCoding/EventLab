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

/** Type guard for {@link HarnessError}, safe across realm boundaries. */
export function isHarnessError(value: unknown): value is HarnessError {
  return value instanceof Error && value.name === "HarnessError";
}
