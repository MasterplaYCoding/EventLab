import type {
  Assertion,
  AssertionContext,
  AssertionReport,
  EventuallyAssertion,
} from "../types.js";
import { describeCause } from "../internal/describeCause.js";

const DEFAULT_EVENTUALLY_TIMEOUT_MS = 2_000;
const DEFAULT_EVENTUALLY_INTERVAL_MS = 50;

function isEventually(assertion: Assertion): assertion is EventuallyAssertion {
  return "eventually" in assertion;
}

/**
 * Runs user assertions after delivery and records each outcome separately.
 *
 * An assertion failing is a statement about the application under test, so it
 * is reported as `failed` and never conflated with a harness error. EventLab
 * does not look at the application's storage itself; it only runs the callback
 * the user supplied and reports what that callback said.
 */
export async function runAssertions(
  assertions: readonly Assertion[],
  context: AssertionContext,
): Promise<AssertionReport[]> {
  const reports: AssertionReport[] = [];

  for (const assertion of assertions) {
    reports.push(
      isEventually(assertion)
        ? await runEventually(assertion, context)
        : await runCheck(assertion.name, () => assertion.check(context)),
    );
  }

  return reports;
}

async function runCheck(
  name: string,
  invoke: () => void | Promise<void>,
): Promise<AssertionReport> {
  const startedAt = performance.now();
  try {
    await invoke();
    return { name, kind: "check", status: "passed", durationMs: elapsed(startedAt) };
  } catch (cause) {
    return {
      name,
      kind: "check",
      status: "failed",
      durationMs: elapsed(startedAt),
      message: describeCause(cause),
    };
  }
}

/**
 * Polls an assertion until it stops throwing or the deadline passes.
 *
 * The distinction between `failed` and `timed-out` is kept: a check that never
 * succeeded within its window is reported as a timeout carrying the *last*
 * failure, which is usually the useful one. A timed-out `eventually` means
 * "this did not become true in time", not "this is false forever".
 */
async function runEventually(
  assertion: EventuallyAssertion,
  context: AssertionContext,
): Promise<AssertionReport> {
  const timeoutMs = assertion.timeoutMs ?? DEFAULT_EVENTUALLY_TIMEOUT_MS;
  const intervalMs = assertion.intervalMs ?? DEFAULT_EVENTUALLY_INTERVAL_MS;
  const startedAt = performance.now();
  const deadline = startedAt + timeoutMs;

  let polls = 0;
  let lastFailure = "assertion never ran";

  for (;;) {
    polls += 1;
    try {
      await assertion.eventually(context);
      return {
        name: assertion.name,
        kind: "eventually",
        status: "passed",
        durationMs: elapsed(startedAt),
        polls,
      };
    } catch (cause) {
      lastFailure = describeCause(cause);
    }

    if (performance.now() >= deadline) {
      return {
        name: assertion.name,
        kind: "eventually",
        status: "timed-out",
        durationMs: elapsed(startedAt),
        polls,
        message: `still failing after ${timeoutMs}ms and ${polls} polls: ${lastFailure}`,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

